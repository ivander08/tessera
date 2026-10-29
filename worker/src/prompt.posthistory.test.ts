import { describe, expect, test } from 'bun:test';

import { buildPrompt } from './prompt';
import type { ChatRow } from './db';
import type { EffectiveSettings } from './effective';
import { exec, makeTestEnv } from './test/harness';

/**
 * Reproduction of the prod complaint: "characters are not dirty by default" on
 * deepseek-v4-1-flash. The user's preset carries an NSFW jailbreak in BOTH its
 * pre-history and post-history slots, but the tail (the position the repo measures
 * as the one that is actually obeyed) is decided by
 * `applyOriginal(card.postHistoryInstructions, presetPostHistory)` — and any
 * non-empty card post-history without `{{original}}` silently discards the preset's
 * post-history from the tail. This test pins that precedence.
 */

const CHAT_ID = 'chat-1';
const CHARACTER_ID = 'char-1';

function settings(over: Partial<EffectiveSettings> = {}): EffectiveSettings {
  return {
    provider: 'kenari',
    model: 'deepseek-v4-1-flash',
    systemPrompt: 'You are a narrator.',
    authorsNote: '',
    maxTokens: 1024,
    contextBudget: 16384,
    cheapContextBudget: 0,
    knobs: {},
    idrPerUsd: null,
    loreScanDepth: 4,
    loreTokenBudget: 1024,
    loreRecursive: false,
    disableReasoning: true,
    stopStrings: [],
    assistantPrefill: '',
    includeNames: false,
    responseLengthRule: '',
    presetPostHistory: '',
    presetSystemPrompt: '',
    presetImpersonation: '',
    presetPreHistory: '',
    ...over,
  };
}

function seed(cardPostHistory: string): { env: Env; chat: ChatRow } {
  const { env, db } = makeTestEnv();
  const now = Date.now();
  exec(
    db,
    `INSERT INTO characters (id, name, avatar, card_json, source_format, tokens, created_at)
     VALUES (?, 'Sydney', NULL, ?, 'ccv3', 10, ?)`,
    CHARACTER_ID,
    JSON.stringify({
      name: 'Sydney',
      description: 'A cold character.',
      personality: '',
      scenario: '',
      firstMes: 'hello',
      mesExample: '',
      systemPrompt: '',
      postHistoryInstructions: cardPostHistory,
    }),
    now,
  );
  exec(
    db,
    `INSERT INTO chats (id, character_id, persona_id, title, preset_id, window_start_seq,
                        session_id, created_at, updated_at)
     VALUES (?, ?, NULL, 't', NULL, 0, 'session-1', ?, ?)`,
    CHAT_ID,
    CHARACTER_ID,
    now,
    now,
  );
  let parent: string | null = null;
  for (let index = 0; index < 2; index += 1) {
    const id = `m${index}`;
    exec(
      db,
      `INSERT INTO messages (id, chat_id, parent_id, role, content, content_tokens, active, created_at)
       VALUES (?, ?, ?, ?, ?, 20, 1, ?)`,
      id,
      CHAT_ID,
      parent,
      index === 0 ? 'assistant' : 'user',
      `turn ${index + 1}`,
      now,
    );
    parent = id;
  }
  const chat: ChatRow = {
    id: CHAT_ID,
    character_id: CHARACTER_ID,
    persona_id: null,
    title: 't',
    preset_id: null,
    window_start_seq: 0,
    session_id: 'session-1',
    last_prefix_hash: null,
    last_prefix_head: null,
    created_at: now,
    updated_at: now,
  };
  return { env, chat };
}

async function systemTail(cardPostHistory: string, presetPostHistory: string): Promise<string> {
  const { env, chat } = seed(cardPostHistory);
  const s = settings({ presetPostHistory });
  const assembled = await buildPrompt(env, chat, s, {
    mode: 'send',
    historyCutoff: null,
    statePoint: { seq: null, inclusive: true },
    userContent: 'next beat',
    tailExtra: '',
  });
  return assembled.messages
    .slice(assembled.tailStart)
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n===\n');
}

const CARD_PH =
  'Sydney stays hostile-cold with {{user}} until real intimacy has been earned over multiple scenes of sustained effort from him: one-word answers, dead stares, walking off mid-sentence, flat casual swearing, and zero initiated physical contact early on. Warmth and touch leak through her actions only after that investment, and even then her words stay flat and dismissive; she denies everything on record.';

const PRESET_NSFW =
  'NSFW is live: use crude words (cock, pussy, ass, fuck) in both dialogue and narration. No euphemisms. She gets horny and takes the lead.';

describe('post-history precedence (prod dirty-by-default complaint)', () => {
  test('a card postHistory without {{original}} discards the preset NSFW postHistory from the tail', async () => {
    const tail = await systemTail(CARD_PH, PRESET_NSFW);
    expect(tail).toContain('stays hostile-cold');
    expect(tail).not.toContain('NSFW is live');
  });

  test('{{original}} in the card postHistory keeps both directives in the tail', async () => {
    const tail = await systemTail(CARD_PH + '\n{{original}}', PRESET_NSFW);
    expect(tail).toContain('stays hostile-cold');
    expect(tail).toContain('NSFW is live');
  });

  test('no card postHistory lets the preset postHistory occupy the tail', async () => {
    const tail = await systemTail('', PRESET_NSFW);
    expect(tail).toContain('NSFW is live');
  });
});
