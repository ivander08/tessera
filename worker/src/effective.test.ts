import { Database } from 'bun:sqlite';
import { describe, expect, test } from 'bun:test';

import { exec, makeTestEnv } from './test/harness';
import { loadEffectiveSettings } from './effective';
import { DEFAULT_SYSTEM_PROMPT, loadChatSettings } from './db';
import { settingsForChat } from './memory/settings';

/**
 * Where a generation setting comes from.
 *
 * One owner per fact: a preset. The chat's preset wins when it names one; otherwise the
 * DEFAULT preset; and an install that has never created one still reads the legacy
 * `settings` row. The layering this replaces had two half-presets — the global screen had
 * a system prompt and a context budget but no pre-history, no stop strings and no response
 * length — so neither layer could be understood on its own.
 */

function makeEnv(): { env: Env; db: Database } {
  const { env, db } = makeTestEnv();
  return { env, db };
}

function setting(db: Database, key: string, value: string): void {
  exec(
    db,
    `INSERT INTO settings (key, value, updated_at) VALUES (?, ?, 0)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    value,
  );
}

function preset(
  db: Database,
  id: string,
  config: Record<string, unknown>,
  knobs: Record<string, unknown> = {},
): void {
  exec(
    db,
    `INSERT INTO presets (id, name, knobs_json, config_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, 0, 0)
     ON CONFLICT(id) DO UPDATE SET knobs_json = excluded.knobs_json, config_json = excluded.config_json`,
    id,
    id,
    JSON.stringify(knobs),
    JSON.stringify(config),
  );
}

describe('loadEffectiveSettings', () => {
  test('an install with no preset still reads the legacy settings row', async () => {
    const { env, db } = makeEnv();
    setting(db, 'provider', 'openrouter');
    setting(db, 'model', 'anthropic/claude-sonnet-4');
    setting(db, 'maxTokens', '2048');
    setting(db, 'contextBudget', '32000');
    setting(db, 'systemPrompt', 'legacy prompt');

    const settings = await loadEffectiveSettings(env, null);

    expect(settings.provider).toBe('openrouter');
    expect(settings.model).toBe('anthropic/claude-sonnet-4');
    expect(settings.maxTokens).toBe(2048);
    expect(settings.contextBudget).toBe(32000);
    expect(settings.systemPrompt).toBe('legacy prompt');
    // No preset means no preset-shaped fields.
    expect(settings.presetPreHistory).toBe('');
    expect(settings.stopStrings).toEqual([]);
  });

  test('a chat with no preset of its own uses the DEFAULT preset', async () => {
    const { env, db } = makeEnv();
    setting(db, 'default_preset_id', 'default-1');
    preset(db, 'default-1', {
      provider: 'kenari',
      model: 'deepseek-v4-1-flash',
      maxTokens: 4096,
      contextSize: 64000,
      systemPrompt: 'from the preset',
      preHistoryInstructions: 'before',
      postHistoryInstructions: 'after',
      stopStrings: ['END'],
      responseLength: 'short',
    });

    // The legacy row is deliberately different, so a wrong source is visible.
    setting(db, 'provider', 'openrouter');
    setting(db, 'model', 'legacy/model');
    setting(db, 'maxTokens', '1024');

    const settings = await loadEffectiveSettings(env, null);

    expect(settings.provider).toBe('kenari');
    expect(settings.model).toBe('deepseek-v4-1-flash');
    expect(settings.maxTokens).toBe(4096);
    expect(settings.contextBudget).toBe(64000);
    expect(settings.systemPrompt).toBe('from the preset');
    expect(settings.presetPreHistory).toBe('before');
    expect(settings.presetPostHistory).toBe('after');
    expect(settings.stopStrings).toEqual(['END']);
    expect(settings.responseLengthRule).toContain('short');
  });

  test("a chat's own preset wins over the default", async () => {
    const { env, db } = makeEnv();
    setting(db, 'default_preset_id', 'default-1');
    preset(db, 'default-1', { model: 'default/model', contextSize: 32000 });
    preset(db, 'chat-preset', {
      model: 'chat/model',
      contextSize: 64000,
      authorsNote: 'stay grounded',
    });

    const settings = await loadEffectiveSettings(env, 'chat-preset');

    expect(settings.model).toBe('chat/model');
    expect(settings.contextBudget).toBe(64000);
    expect(settings.authorsNote).toBe('stay grounded');
  });

  test('the cheap pair defaults to the narrator pair, and can differ from it', async () => {
    const { env, db } = makeEnv();
    setting(db, 'default_preset_id', 'p1');
    preset(db, 'p1', { provider: 'kenari', model: 'big/model' });

    const inherited = await loadEffectiveSettings(env, null);
    expect(inherited.cheapProvider).toBe('kenari');
    expect(inherited.cheapModel).toBe('big/model');

    preset(db, 'p1', {
      provider: 'kenari',
      model: 'big/model',
      cheapProvider: 'openrouter',
      cheapModel: 'small/model',
      cheapContextBudget: 20000,
      reasoning: true,
    });

    const explicit = await loadEffectiveSettings(env, null);
    expect(explicit.cheapProvider).toBe('openrouter');
    expect(explicit.cheapModel).toBe('small/model');
    expect(explicit.cheapContextBudget).toBe(20000);
    expect(explicit.disableReasoning).toBe(false);
  });

  test('a preset that sets no prompt keeps the legacy one until it does', async () => {
    // The compatibility case that matters for an existing install: the preset predates
    // these fields, so it must inherit the reader's text rather than the app default.
    const { env, db } = makeEnv();
    setting(db, 'default_preset_id', 'p1');
    preset(db, 'p1', { model: 'some/model' });
    setting(db, 'systemPrompt', 'the reader wrote this');
    setting(db, 'authorsNote', 'and this');

    const settings = await loadEffectiveSettings(env, null);
    expect(settings.systemPrompt).toBe('the reader wrote this');
    expect(settings.authorsNote).toBe('and this');

    preset(db, 'p1', { model: 'some/model', systemPrompt: 'preset wins', authorsNote: 'preset note' });
    const owned = await loadEffectiveSettings(env, null);
    expect(owned.systemPrompt).toBe('preset wins');
    expect(owned.authorsNote).toBe('preset note');
  });

  test('a preset that sets no system prompt gets the app default, not an empty one', async () => {
    // An empty system prompt is not "no opinion" at the provider — it is a chat with no
    // instruction at all, which is a different (and worse) product.
    const { env, db } = makeEnv();
    setting(db, 'default_preset_id', 'p1');
    preset(db, 'p1', { model: 'some/model' });

    expect((await loadEffectiveSettings(env, null)).systemPrompt).toBe(DEFAULT_SYSTEM_PROMPT);
  });

  test('the IDR rate stays a setting: it prices turns, it does not generate them', async () => {
    const { env, db } = makeEnv();
    setting(db, 'default_preset_id', 'p1');
    preset(db, 'p1', { model: 'some/model' });
    setting(db, 'idrPerUsd', '16000');

    expect((await loadEffectiveSettings(env, null)).idrPerUsd).toBe(16000);
  });

  test('a preset id that no longer exists falls back to the app defaults, not to a crash', async () => {
    const { env } = makeEnv();
    const settings = await loadEffectiveSettings(env, 'deleted-preset');

    expect(settings.maxTokens).toBe(1024);
    expect(settings.contextBudget).toBe(16384);
  });

  test('the legacy reader is unchanged, so the migration card can price it', async () => {
    const { env, db } = makeEnv();
    setting(db, 'provider', 'kenari');
    setting(db, 'cheapProvider', 'openrouter');
    setting(db, 'cheapModel', 'small/model');

    const legacy = await loadChatSettings(env);
    expect(legacy.provider).toBe('kenari');
    expect(legacy.cheapProvider).toBe('openrouter');
    expect(legacy.cheapModel).toBe('small/model');
  });
});

describe('a chat-scoped side-channel model', () => {
  test("the chat's preset decides the cheap pair, not the default preset", async () => {
    // The reported bug: a chat attached to a preset naming deepseek-v4-pro kept answering
    // its consultant and its summaries with the DEFAULT preset's glm-5-3-flash, so changing
    // the model looked like it did nothing.
    const { env, db } = makeEnv();
    setting(db, 'default_preset_id', 'default-1');
    preset(db, 'default-1', { provider: 'kenari', model: 'glm-5-3-flash' });
    preset(db, 'chat-preset', {
      provider: 'kenari',
      model: 'deepseek-v4-pro',
      cheapProvider: 'kenari',
      cheapModel: 'deepseek-v4-pro',
    });
    exec(
      db,
      `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                          session_id, created_at, updated_at)
       VALUES ('chat-1', NULL, NULL, 't', 'chat-preset', 0, 's', 0, 0)`,
    );

    const chatScoped = await settingsForChat(env, 'chat-1');
    expect(chatScoped.cheapModel).toBe('deepseek-v4-pro');

    // The default preset is still the right answer for work that belongs to no chat.
    const background = await loadEffectiveSettings(env, null);
    expect(background.cheapModel).toBe('glm-5-3-flash');
  });

  test('a chat with no preset falls back to the default preset', async () => {
    const { env, db } = makeEnv();
    setting(db, 'default_preset_id', 'default-1');
    preset(db, 'default-1', { provider: 'kenari', model: 'glm-5-3-flash' });
    exec(
      db,
      `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                          session_id, created_at, updated_at)
       VALUES ('chat-1', NULL, NULL, 't', NULL, 0, 's', 0, 0)`,
    );

    expect((await settingsForChat(env, 'chat-1')).cheapModel).toBe('glm-5-3-flash');
  });
});
