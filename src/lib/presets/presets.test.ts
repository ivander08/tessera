import { describe, expect, test } from 'bun:test';
import { parseFf5, requiresRegexPack } from './ff5';
import { PresetParseError, parsePresetFile } from './importSt';
import { buildSupportMap, knobSupport } from './knobSupport';

/**
 * Every ST sampler name the importer claims to understand, with the Tessera name it
 * must become. This is the knob map, written out independently of the implementation so
 * a silent rename in the source cannot pass by editing the expectation too.
 */
const FULL_TEXTGEN_KNOB_MAP: Array<[string, string, number]> = [
  ['temp', 'temperature', 0.8],
  ['top_p', 'top_p', 0.95],
  ['top_k', 'top_k', 40],
  ['min_p', 'min_p', 0.02],
  ['rep_pen', 'repetition_penalty', 1.1],
  ['freq_pen', 'frequency_penalty', 0.1],
  ['presence_pen', 'presence_penalty', 0.2],
  ['dry_multiplier', 'dry_multiplier', 0.8],
  ['xtc_probability', 'xtc_probability', 0.5],
  ['seed', 'seed', 42],
];

/**
 * SillyTavern's own shipped `default/content/presets/textgen/Default.json` sampler chain,
 * verbatim. `tfs_z` and `typical_p` are in it and are not llama.cpp sampler names.
 */
const ST_DEFAULT_SAMPLERS = [
  'penalties',
  'dry',
  'top_n_sigma',
  'top_k',
  'typ_p',
  'tfs_z',
  'typical_p',
  'xtc',
  'top_p',
  'min_p',
  'temperature',
];

describe('ST preset import — the two namespaces are disjoint', () => {
  test('a chat-completion preset does not gain DRY or XTC, even when the file carries them', () => {
    // ST never constructs dry_* for chat completion, so a file in this namespace that
    // happens to contain one is a file ST itself ignored. Importing it would turn on a
    // knob the preset never defined.
    const preset = parsePresetFile({
      name: 'stray.json',
      json: {
        oai_settings: { temp: 0.9, top_p: 1, dry_multiplier: 0.8, xtc_probability: 0.5 },
      },
    });

    expect(preset.kind).toBe('chat');
    expect(preset.knobs).toEqual({ temperature: 0.9, top_p: 1 });
    expect('dry_multiplier' in preset.knobs).toBe(false);
    expect('xtc_probability' in preset.knobs).toBe(false);
    expect(preset.dropped.join('\n')).toContain('dry_multiplier: not defined by the chat-completion namespace');
    expect(preset.dropped.join('\n')).toContain('xtc_probability: not defined by the chat-completion namespace');
  });

  test('a text-completion preset keeps DRY and XTC and rejects the chat-only spellings', () => {
    const preset = parsePresetFile({
      name: 'textgen.json',
      json: {
        textgenerationwebui_settings: {
          temp: 0.8,
          dry_multiplier: 0.8,
          xtc_probability: 0.5,
          // Chat-completion spellings. ST's text-completion namespace uses `temp`, so
          // these were never going to be sent from this side either.
          temperature: 0.8,
          repetition_penalty: 1.1,
        },
      },
    });

    expect(preset.kind).toBe('textgen');
    expect(preset.knobs).toEqual({ temperature: 0.8, dry_multiplier: 0.8, xtc_probability: 0.5 });
    expect(preset.dropped.join('\n')).toContain('temperature: not defined by the text-completion namespace');
    expect(preset.dropped.join('\n')).toContain('repetition_penalty: not defined by the text-completion namespace');
  });

  test('community chat-completion presets write OpenAI spellings and those import as-is', () => {
    // Sinatra and Nemo Engine both do this; the chat namespace accepts both spellings.
    const preset = parsePresetFile({
      name: 'sinatra.json',
      json: {
        temperature: 0.8,
        top_p: 1,
        top_k: 0,
        min_p: 0,
        repetition_penalty: 1,
        frequency_penalty: 0,
        presence_penalty: 0,
        seed: -1,
        prompts: [{ identifier: 'main', name: 'Main', content: 'x' }],
        prompt_order: [{ character_id: 100000, order: [{ identifier: 'main', enabled: true }] }],
      },
    });

    expect(preset.kind).toBe('chat');
    expect(preset.knobs).toEqual({
      temperature: 0.8,
      top_p: 1,
      top_k: 0,
      min_p: 0,
      repetition_penalty: 1,
      frequency_penalty: 0,
      presence_penalty: 0,
      seed: -1,
    });
    expect(preset.prompts).toHaveLength(1);
  });
});

describe('ST preset import — namespace detection for unwrapped files', () => {
  test('the text-completion sampler quartet identifies the text-completion namespace', () => {
    const preset = parsePresetFile({
      name: 'Default.json',
      json: { temp: 0.8, top_k: 40, top_p: 0.95, rep_pen: 1, dry_multiplier: 0.8 },
    });
    expect(preset.kind).toBe('textgen');
    expect(preset.knobs.dry_multiplier).toBe(0.8);
  });

  test('a Prompt Manager list identifies the chat-completion namespace', () => {
    const preset = parsePresetFile({
      name: 'preset.json',
      json: { prompts: [{ identifier: 'main', name: 'Main', content: 'x', role: 'system' }] },
    });
    expect(preset.kind).toBe('chat');
    expect(preset.prompts).toHaveLength(1);
  });

  test('a file that is neither namespace is an error, not an empty preset', () => {
    expect(() => parsePresetFile({ name: 'card.json', json: { spec: 'chara_card_v2' } })).toThrow(PresetParseError);
    expect(() => parsePresetFile({ name: 'x.json', json: [1, 2, 3] })).toThrow(PresetParseError);
  });

  test('the preset name falls back to the filename when the file declares none', () => {
    // ST's shipped text-completion presets and every community FF preset do this.
    const preset = parsePresetFile({ name: 'Default.json', json: { temp: 1, top_k: 0, top_p: 1 } });
    expect(preset.name).toBe('Default');
  });
});

describe('ST preset import — the full knob map', () => {
  test('every mapped ST sampler name becomes its Tessera name', () => {
    const source: Record<string, number> = {};
    for (const [st, , value] of FULL_TEXTGEN_KNOB_MAP) source[st] = value;

    const preset = parsePresetFile({ name: 'knobs.json', json: { textgenerationwebui_settings: source } });

    for (const [st, tessera, value] of FULL_TEXTGEN_KNOB_MAP) {
      expect(preset.knobs[tessera]).toBe(value);
      // Identity mappings (top_p -> top_p, seed -> seed) legitimately keep the ST name.
      if (st !== tessera) expect(st in preset.knobs).toBe(false);
    }
    expect(Object.keys(preset.knobs).sort()).toEqual(FULL_TEXTGEN_KNOB_MAP.map(([, t]) => t).sort());
    expect(preset.dropped).toEqual([]);
  });
});

describe('ST preset import — sampler-chain normalization', () => {
  test('tfs_z and typical_p are dropped with the llama.cpp reason', () => {
    // Straight from ST's shipped textgen/Default.json.
    const preset = parsePresetFile({
      name: 'Default.json',
      json: { temp: 0.8, top_k: 40, top_p: 0.95, rep_pen: 1, samplers: ST_DEFAULT_SAMPLERS },
    });

    const tfs = preset.dropped.find((entry) => entry.startsWith('samplers: tfs_z'));
    const typical = preset.dropped.find((entry) => entry.startsWith('samplers: typical_p'));

    expect(tfs).toContain('not a valid llama.cpp sampler');
    expect(tfs).toContain('llama.cpp silently drops it with only a log warning');
    expect(typical).toContain('not a valid llama.cpp sampler');
    expect(typical).toContain('llama.cpp silently drops it with only a log warning');

    // The valid members of the chain are not reported as invalid samplers.
    expect(preset.dropped.some((entry) => entry.startsWith('samplers: top_k'))).toBe(false);
    expect(preset.dropped.some((entry) => entry.startsWith('samplers: typ_p'))).toBe(false);
  });

  test('the sampler chain itself never becomes a knob', () => {
    const preset = parsePresetFile({
      name: 'Default.json',
      json: { temp: 0.8, top_k: 40, top_p: 0.95, rep_pen: 1, samplers: ST_DEFAULT_SAMPLERS },
    });
    expect('samplers' in preset.knobs).toBe(false);
    // ...and the reason it was dropped is stated, not left implicit.
    expect(preset.dropped.join('\n')).toContain('the llama.cpp sampler chain is not portable');
  });
});

describe('ST preset import — regex scripts and prompts', () => {
  test('regex scripts and prompt entries survive the import', () => {
    const preset = parsePresetFile({
      name: 'chat.json',
      json: {
        prompts: [{ identifier: 'main', name: 'Main', content: 'Stay in character.', role: 'system', enabled: true }],
        extensions: {
          regex_scripts: [
            { scriptName: 'Strip', findRegex: '/x/g', replaceString: '', disabled: true },
          ],
        },
      },
    });

    expect(preset.regex).toEqual([{ scriptName: 'Strip', findRegex: '/x/g', replaceString: '', disabled: true }]);
    expect(preset.prompts).toEqual([
      { identifier: 'main', name: 'Main', content: 'Stay in character.', role: 'system', enabled: true },
    ]);
  });
});

describe('FF5 import', () => {
  test('parses 63 prompt entries and 25 regex scripts from the real FF 5.4 file', () => {
    const preset = parseFf5(FF54);

    expect(preset.kind).toBe('ff5');
    expect(preset.prompts).toHaveLength(63);
    expect(preset.regex).toHaveLength(25);

    // The nine Internal State modules plus the CoT controller are user-role injections
    // at depth 0 — the reason the regex pack is mandatory, since they emit the markup
    // the regexes strip back out. World Sim and Chekhov's Gun ship disabled.
    const userPrompts = preset.prompts.filter((prompt) => prompt.role === 'user');
    expect(userPrompts).toHaveLength(13);
    expect(userPrompts.filter((prompt) => prompt.enabled === true)).toHaveLength(8);
    const stateNames = userPrompts.map((prompt) => prompt.name.trim());
    for (const name of ['DnD Simulator', 'Internal Agenda', "GM's Notebook", 'Internal States']) {
      expect(stateNames.some((entry) => entry.includes(name))).toBe(true);
    }

    // Spot-check one script's real payload rather than only its name.
    const contextSaver = preset.regex.find((script) => script.scriptName === 'FF5 - Context Saver (Universal)');
    expect(contextSaver?.findRegex).toContain('GFX_START');
    expect(contextSaver?.findRegex).toContain('internal_states');

    // Marker prompts carry no content in ST's format and must not be invented.
    const history = preset.prompts.find((prompt) => prompt.identifier === 'chatHistory');
    expect(history?.content).toBe('');
  });

  test('accepts the standalone FF5 regex suite (a flat array) as well as the embedded one', () => {
    const preset = parseFf5({ name: 'FF5 Regex 3.0 Suite', prompts: [], regex: FF54_REGEX });
    expect(preset.regex).toHaveLength(25);
    expect(preset.name).toBe('FF5 Regex 3.0 Suite');
  });

  test('requiresRegexPack is true for prompts without regex, false once the pack is present', () => {
    expect(requiresRegexPack(parseFf5({ prompts: FF54_PROMPTS }))).toBe(true);
    expect(requiresRegexPack(parseFf5({ prompts: FF54_PROMPTS, regex: FF54_REGEX }))).toBe(false);
    // A regex-only pack is not a preset that needs its regexes; it *is* the regexes.
    expect(requiresRegexPack(parseFf5({ regex: FF54_REGEX }))).toBe(false);
  });
});

describe('knob support', () => {
  const models = [
    { id: 'openrouter/full', supported_parameters: ['temperature', 'top_p', 'top_k', 'min_p', 'seed'] },
    { id: 'openrouter/limited', supported_parameters: ['temperature', 'max_tokens'] },
  ];

  test('an OpenRouter model that lists top_k supports it', () => {
    const map = buildSupportMap(models);
    expect(knobSupport(map, 'openrouter/full', 'top_k', 'openrouter')).toEqual({ supported: true, reason: '' });
    expect(knobSupport(map, 'openrouter/full', 'min_p', 'openrouter')).toEqual({ supported: true, reason: '' });
  });

  test('an OpenRouter model that does not list a knob refuses it with a reason', () => {
    const map = buildSupportMap(models);
    const support = knobSupport(map, 'openrouter/limited', 'top_k', 'openrouter');
    expect(support.supported).toBe(false);
    expect(support.reason).toContain('top_k');
  });

  test('an OpenRouter model missing from the map is assumed supported, never blocked', () => {
    const map = buildSupportMap(models);
    expect(knobSupport(map, 'openrouter/not-fetched-yet', 'dry_multiplier', 'openrouter').supported).toBe(true);
  });

  test('Kenari greys out top_k and explains why', () => {
    const map = buildSupportMap(models);
    const topK = knobSupport(map, 'deepseek-v4-1-flash', 'top_k', 'kenari');
    expect(topK.supported).toBe(false);
    expect(topK.reason).toBe('Kenari does not document this parameter.');

    // Kenari's documented field set is the whole allowlist.
    expect(knobSupport(map, 'deepseek-v4-1-flash', 'temperature', 'kenari').supported).toBe(true);
    expect(knobSupport(map, 'deepseek-v4-1-flash', 'top_p', 'kenari').supported).toBe(true);
    expect(knobSupport(map, 'deepseek-v4-1-flash', 'frequency_penalty', 'kenari').supported).toBe(true);
    expect(knobSupport(map, 'deepseek-v4-1-flash', 'presence_penalty', 'kenari').supported).toBe(true);
    expect(knobSupport(map, 'deepseek-v4-1-flash', 'dry_multiplier', 'kenari').supported).toBe(false);
    expect(knobSupport(map, 'deepseek-v4-1-flash', 'xtc_probability', 'kenari').supported).toBe(false);
    expect(knobSupport(map, 'deepseek-v4-1-flash', 'seed', 'kenari').supported).toBe(false);
  });

  test('a Kenari entry in the map is still judged by Kenari\'s field set', () => {
    // Kenari publishes no supported_parameters; a stale or hand-made map entry must not
    // override the documented allowlist.
    const map = buildSupportMap([{ id: 'deepseek-v4-1-flash', supported_parameters: ['top_k'] }]);
    expect(knobSupport(map, 'deepseek-v4-1-flash', 'top_k', 'kenari').supported).toBe(false);
  });
});

/* ---------------------------------------------------------------------------------
 * Fixtures.
 *
 * FF54_PROMPTS / FF54_REGEX are the real FF 5.4 Internal States preset, taken from the
 * canonical archive download (rentry.co/freaky-frankenstein-presets). Identifiers,
 * names, roles, enabled flags and findRegex strings are verbatim; long prompt bodies and
 * the multi-kilobyte HTML replaceStrings are truncated because they are payload, not
 * shape. The counts (63 / 25) and the regex contents are the acceptance criteria.
 * ------------------------------------------------------------------------------- */

const FF54_PROMPTS: Array<{ identifier: string; name: string; content?: string; role?: string; enabled?: boolean }> = [
    { identifier: "main", name: "⚡️Main Prompt 🤖", content: "{{setvar::bondsTemplate::}}{{setvar::invTemplate", role: "system" },
    { identifier: "019f62e8-892f-7002-8fcf-eea637bd577b", name: "⏰ Time and Place 🌅", content: "{{// Grounds scene with date, time, location, we", role: "system", enabled: true },
    { identifier: "019f62e8-892f-7003-9af1-422c676672ae", name: "=Pick one Prose Style 👇 ================", content: "{{//Keep toggled off}}{{trim}}", role: "system", enabled: false },
    { identifier: "d7bfe956-b315-4049-845d-ad4a6f9bfd28", name: "📖Story Mode ✍🏻", content: "{{//This tells the AI to write like an author wo", role: "system", enabled: false },
    { identifier: "019f62e8-892f-7005-a3b1-4b59aaebebcd", name: "🎬Cinematic Realism 🎥 ", content: "{{//This tells the AI to write gritty realism an", role: "system", enabled: true },
    { identifier: "019f62e8-892f-7006-9eac-e4939663e934", name: "=Pick one POV 👇 ================", content: "{{//Keep toggled off}}{{trim}}", role: "system", enabled: false },
    { identifier: "019f62e8-892f-7007-bb78-86fc2ab61efe", name: "👀3rd person POV🦅", content: "<POV>\nMode: 3rd Person Limited.\nTense: Past tens", role: "system", enabled: false },
    { identifier: "019f62e8-892f-7008-bbb9-b6ebf9cdc0f5", name: "👀2nd person POV🦅", content: "<POV>\nMode: 2nd Person POV.\nTense: Present tense", role: "system", enabled: false },
    { identifier: "019f62e8-892f-7009-a5c5-9a06eb0b6640", name: "👀1st person POV🦅", content: "<POV>\nMode: 1st Person Subjective.\nTense: Presen", role: "system", enabled: false },
    { identifier: "019f62e8-892f-700a-8e10-84695d624918", name: "👀Hybrid POV🥵🥶😣", content: "{{//this is my own personal favorite and now pop", role: "system", enabled: true },
    { identifier: "019f62e8-892f-700b-8e2a-cc0ab77ec55d", name: "=🚫Pick one NSFW Toggle 👇==============", content: "{{//Keep toggled off}}{{trim}}", role: "system", enabled: false },
    { identifier: "019f62e8-892f-700c-9795-53ecb3381d7d", name: "🔞Realism Mode / Jailbreak ❤️💋", content: "{{// Toggling this on gives YOUR consent, so rea", role: "system", enabled: false },
    { identifier: "019f62e8-892f-700d-b070-4add983aeae1", name: "🔞Freaky Mode / Jailbreak ❤️💋 ", content: "{{// Toggling this on gives YOUR consent, so rea", role: "system", enabled: true },
    { identifier: "019f62e8-892f-700e-b3e9-f50931297b58", name: "=Pick one (echo vs anti-echo)==========", content: "{{//Keep toggled off}}{{trim}}", role: "system", enabled: false },
    { identifier: "019f62e8-892f-700f-93e0-640159f4d52a", name: "🦜 Anti-parrot and anti-echo 💬", content: "{{//This prevents the users actions from being r", role: "system", enabled: true },
    { identifier: "019f62e8-892f-7010-bf59-e7b17fd4476f", name: "🧂Embellish Mode- Experimental 🧙‍♂️", content: "{{//NEW! Turn off anti echo and use this prompt ", role: "system", enabled: false },
    { identifier: "019f62e8-892f-7011-980c-f01846f6c97f", name: "=✍🏻Edit custom toggles 👇==============", content: "{{//Keep toggled off}}{{trim}}", role: "system", enabled: false },
    { identifier: "079ce45e-d344-4e75-a5a5-be6ae3037c91", name: "Kimi K3", content: "<Prefill>\n\n\n<Technical>\n\n\nLLM model: {{Kimi-K3}}", role: "assistant", enabled: false },
    { identifier: "019f62e8-892f-7012-98b4-8de29f11aa1d", name: "📝Total Output Length🚦", content: "{{// customize the total output of\nThe AI here t", role: "system", enabled: true },
    { identifier: "019f62e8-892f-7017-ae2e-44fbc7d29de7", name: "🎤NPC Voice + Dialogue 2.0 Output🗣️", content: "\n{{// customize total output of NPC spoken dialo", role: "system", enabled: true },
    { identifier: "0b0afd85-71ea-45ee-99cf-cb72faf19fac", name: "🎤NPC Voice + Dialogue Output🗣️ 1", content: "\n{{// customize total output of NPC spoken dialo", role: "system", enabled: true },
    { identifier: "019f62e8-892f-7015-9be8-a0015ebd2c1d", name: "🧘Anti-Omniscient NPCs and Thoughts 💥🧠", content: "{{//list of logical rules that combine to help p", role: "system", enabled: true },
    { identifier: "019f62e8-892f-7016-a021-aa24f58271d6", name: "🎭NPC Instincts + VAD Emotions🎥🎬", content: "{{// this is to increase the emotional output of", role: "system", enabled: true },
    { identifier: "019f62e8-892f-7014-9d71-8bedfe4ac3ef", name: "🪧Realistic NPCs 👬", content: "{{//this combines a very lightweight version of ", role: "system", enabled: true },
    { identifier: "019f62e8-892f-7013-9e9b-13eae330f5a0", name: "🚫Banned Word List📝", content: "{{// banned words list. Prevents the ai from usi", role: "system", enabled: true },
    { identifier: "d704565e-6357-41ab-ba0c-a4f11514dcc9", name: "=Pick one Color Option👇 ================", content: "{{//Keep toggled off}}{{trim}}", role: "system", enabled: false },
    { identifier: "019f62e8-892f-7019-be65-715a4949cba0", name: "🌈 Colored Dialogue 2.0 VN🖍️", content: "{{// This is a strictly optional toggle which tu", role: "system", enabled: true },
    { identifier: "2105050a-0d4b-4661-9363-3cc1ac44d5e7", name: "🌈 Colored Dialogue VN🖍️ copy", content: "{{// This is a strictly optional toggle which tu", role: "system", enabled: false },
    { identifier: "019f62e8-892f-701a-afd5-49222c79fdb6", name: "👾Pop in Graphics 💻", content: "{{// in game graphics toggle. Toggle on and you ", role: "system", enabled: true },
    { identifier: "019f62e8-892f-701b-bab1-563021fd8b14", name: "⚔️ Spectacle Combat Physics 💥", content: "{{// enhances fight scenes making them play out ", role: "system", enabled: true },
    { identifier: "019f62e8-892f-701c-8550-08ebf33e9da2", name: "💥Onomatopoeia Mode 🔊", content: "{{// Turn this toggle on if you want the comic b", role: "system", enabled: false },
    { identifier: "019f62e8-892f-701d-8f83-6d62af427132", name: "⛓️‍💥 Icebreaker Test ⛓️", content: "{{// This is a stronger jailbreak. Turn on ONLY ", role: "assistant", enabled: true },
    { identifier: "019f62e8-892f-701e-ba47-40b8c3ddd5e8", name: "🧬 HQ NPC Genesis 🆕", content: "{{// This improves NPC creation when and IF the ", role: "system", enabled: true },
    { identifier: "019f62e8-892f-7028-bad6-be1f427c3ae4", name: "📲Twitter X Feed 🎨", content: "{{// This is just a silly fun social media feed ", role: "system", enabled: false },
    { identifier: "worldInfoBefore", name: "Lorebook Before" },
    { identifier: "personaDescription", name: "Persona Description" },
    { identifier: "charDescription", name: "Char Description" },
    { identifier: "charPersonality", name: "Char Personality" },
    { identifier: "scenario", name: "Scenario" },
    { identifier: "worldInfoAfter", name: "Lorebook After" },
    { identifier: "dialogueExamples", name: "Chat Examples" },
    { identifier: "chatHistory", name: "Chat History" },
    { identifier: "019f62e8-892f-701f-8580-cf218b8e6be5", name: "🧘=Pick Internal States👇 ================", content: "{{//Keep this toggled off. Remember to only pick", role: "system", enabled: false },
    { identifier: "019f62e8-892f-7021-97a6-42e1b83eaad3", name: " 🐉🗡️DnD Simulator 🎲", content: "{{// Internal States. Turn this on if you want t", role: "user", enabled: true },
    { identifier: "019f67b4-7381-7000-bcc4-496b2e6ed920", name: " 📅 Internal Agenda", content: "{{// Internal States: Off-screen NPC schedule an", role: "user", enabled: true },
    { identifier: "019f67ad-c0b1-7000-aca4-0e2480fa02db", name: "📒 GM's Notebook", content: "{{// Internal States: Persistent GM memory scrat", role: "user", enabled: true },
    { identifier: "019f62e8-892f-7022-9eb9-e00c2944ebc6", name: "🗡️Inventory, Feats, Titles 💪", content: "{{// Internal States. Turn this on to work in ta", role: "user", enabled: true },
    { identifier: "019f62e8-892f-7023-825d-9351eca0347f", name: " 🥰 Relationships RPG ❤️ 😡", content: "{{// Internal States: Autonomous relationship an", role: "user", enabled: true },
    { identifier: "019f62e8-892f-7024-a40f-b906fceb58d2", name: "🌎World Sim 🎲", content: "{{// Internal States: Background world simulatio", role: "user", enabled: false },
    { identifier: "019f62e8-892f-7025-be65-8859e7730ee0", name: "🔫Chekhov's Gun: Secrets / Lies / Plants", content: "{{// Internal States.  The Chekhov’s Gun Tracker", role: "user", enabled: false },
    { identifier: "019f62e8-892f-7026-92ea-34ff510c244b", name: "🧠 Internal Thoughts 💭 ", content: "{{// Internal States: Raw, persona-driven NPC th", role: "user", enabled: true },
    { identifier: "019f62e8-892f-7027-93ef-159f3d55c410", name: "👾Internal States 💾🎮", content: "{{// This is our biggest change in the Freaky Fr", role: "user", enabled: true },
    { identifier: "019f62e8-892f-7031-a8d8-aa94d06644a2", name: "🧠=Pick one CoT Style 👇 ================", content: "{{//Keep toggled off. You can pick one CoT! ⚡️ B", role: "system", enabled: false },
    { identifier: "019f62e8-892f-7032-b004-1869f8bc0782", name: "🪺MAX Chain of Thought (Nested Gates) 🔬", content: "{{//Can be turned off to utilize LLMs natural re", role: "user", enabled: false },
    { identifier: "634ecfec-1862-4ce0-821e-e31057acadfa", name: "⚡️BOLT Chain of Thought 🧠", content: "{{//Can be turned off to utilize LLMs natural re", role: "user", enabled: true },
    { identifier: "b5db9430-857a-408c-817c-32e975a71430", name: "🏎️Micro Chain of Thought💨", content: "{{//Can be turned off to utilize LLMs natural re", role: "user", enabled: false },
    { identifier: "019f62e8-892f-703f-935b-f2f072d4eede", name: "Auto Image Gen SDXL Anime Style", content: "{{// FF5 Toggle — Auto Image Gen ANIME MODE 🎌. ", role: "user", enabled: false },
    { identifier: "jailbreak", name: "Post-History Instructions", content: "{{//Third and final jailbreak. Leave off default", role: "system" },
    { identifier: "019f62e8-892f-7000-9a7f-4d15c1234fb9", name: "Debug Engine", content: "<internal_debugengine>\nPurpose: developer testin", role: "system", enabled: false },
    { identifier: "019f62e8-892f-7004-9f5d-a76527a7fcc9", name: "📖Story Mode ✍🏻", content: "{{//This tells the AI to write like an author wo", role: "system", enabled: false },
    { identifier: "019f62e8-892f-7018-a6ba-bfb2077ccfa7", name: "🎤NPC Voice + Dialogue Output🗣️ Large", content: "{{// customize total output of NPC spoken dialog", role: "system", enabled: false },
    { identifier: "enhanceDefinitions", name: "Enhance Definitions", content: "If you have more knowledge of {{char}}, add to t", role: "system" },
    { identifier: "nsfw", name: "Auxiliary Prompt", role: "system" },
];

const FF54_REGEX: Array<{ scriptName: string; findRegex: string; replaceString: string; disabled?: boolean }> = [
    { scriptName: "FF5 Delete - Untagged Thoughts", findRegex: "/^\\s{0,20}([^<\\[\\s][\\s\\S]{0,30000}?)(?:\\n\\s{0,8}[-—_*]{3,}\\s{0,8}\\n|\\n{1,10})(\\[\\s{0,8}[^\\]\\n]{0,30}\\bTime\\b)/gi", replaceString: "$2", disabled: false },
    { scriptName: "FF5 Catch - Untagged Thoughts", findRegex: "/^\\s{0,20}([^<\\[\\s][\\s\\S]{0,30000}?)(?:\\n\\s{0,8}[-—_*]{3,}\\s{0,8}\\n|\\n{1,10})(\\[\\s{0,8}[^\\]\\n]{0,30}\\bTime\\b)/gi", replaceString: "<details style=\"background: rgba(147, 51, 234, 0.08); bor...", disabled: false },
    { scriptName: "FF5 UI - Collapse Detail Spacing", findRegex: "/<\\/details>(?:\\s|<br>|<br\\/>|<br \\/>|<p>|<p\\/>|<p \\/>|<\\/p>)+<details/gi", replaceString: "</details><details", disabled: false },
    { scriptName: "FF5 - Context Saver (Universal)", findRegex: "/(?:<!--\\s{0,8}GFX_START\\s{0,8}-->|<internal_states>)[\\s\\S]{0,50000}?(?:<!--\\s{0,8}GFX_END\\s{0,8}-->|<\\/internal_states>|$)/gi", replaceString: "", disabled: false },
    { scriptName: "FF5 Repair - Summary Auto-Close", findRegex: "/<summary>([^<\\n\\r]{1,100})\\n(?!\\s{0,8}<\\/summary>)/gi", replaceString: "<summary>$1</summary>", disabled: false },
    { scriptName: "FF5 Repair - GFX Trailing Unfence", findRegex: "/(<!--\\s{0,8}GFX_END\\s{0,8}-->|<\\/internal_states>|<\\/details>)\\s{0,8}\\n?\\s{0,8}```/gi", replaceString: "$1", disabled: false },
    { scriptName: "FF5 Repair - GFX Unfence", findRegex: "/```(?:html|xml|markdown)?\\s{0,8}\\n?\\s{0,8}(<!--\\s{0,8}GFX_START\\s{0,8}-->|<internal_states>|<details>)/gi", replaceString: "$1", disabled: false },
    { scriptName: "Tremble Dialogue Regex", findRegex: "/<\\s{0,8}(?:color\\s{0,8}:\\s{0,8})?(cyan|pink|teal|orange|gold|violet|salmon|orchid|yellow|plum)[^>]{0,120}\\btremble\\b[^>]{0,120}>([“\"][^”\"]{1,2000}?[”\"])(?:\\s{0,8}<\\s{0,8}\\/\\s{0,8}[^<>\\n\\r]{0,40}>|\\s{0,8}<\\s{0,8}\\/\\s{0,8}[a-zA-Z0-9_-]{0,24}:|\\s{0,8}(?:\\1|tremble)>)?/gi", replaceString: "<span style=\"color:$1;letter-spacing:1.5px;opacity:0.85;f...", disabled: false },
    { scriptName: "Measured Dialogue Regex", findRegex: "/<\\s{0,8}(?:color\\s{0,8}:\\s{0,8})?(cyan|pink|teal|orange|gold|violet|salmon|orchid|yellow|plum)[^>]{0,120}\\bmeasured\\b[^>]{0,120}>([“\"][^”\"]{1,2000}?[”\"])(?:\\s{0,8}<\\s{0,8}\\/\\s{0,8}[^<>\\n\\r]{0,40}>|\\s{0,8}<\\s{0,8}\\/\\s{0,8}[a-zA-Z0-9_-]{0,24}:|\\s{0,8}(?:\\1|measured)>)?/gi", replaceString: "<span style=\"color:$1;font-weight:bold;letter-spacing:0.8...", disabled: false },
    { scriptName: "Whisper Dialogue Regex", findRegex: "/<\\s{0,8}(?:color\\s{0,8}:\\s{0,8})?(cyan|pink|teal|orange|gold|violet|salmon|orchid|yellow|plum)[^>]{0,120}\\bwhisper\\b[^>]{0,120}>([“\"][^”\"]{1,2000}?[”\"])(?:\\s{0,8}<\\s{0,8}\\/\\s{0,8}[^<>\\n\\r]{0,40}>|\\s{0,8}<\\s{0,8}\\/\\s{0,8}[a-zA-Z0-9_-]{0,24}:|\\s{0,8}(?:\\1|whisper)>)?/gi", replaceString: "<span style=\"color:$1;font-size:0.85em;opacity:0.75;font-...", disabled: false },
    { scriptName: "Shout Dialogue Regex", findRegex: "/<\\s{0,8}(?:color\\s{0,8}:\\s{0,8})?(cyan|pink|teal|orange|gold|violet|salmon|orchid|yellow|plum)[^>]{0,120}\\bshout\\b[^>]{0,120}>([“\"][^”\"]{1,2000}?[”\"])(?:\\s{0,8}<\\s{0,8}\\/\\s{0,8}[^<>\\n\\r]{0,40}>|\\s{0,8}<\\s{0,8}\\/\\s{0,8}[a-zA-Z0-9_-]{0,24}:|\\s{0,8}(?:\\1|shout)>)?/gi", replaceString: "<span style=\"color:$1;font-size:1.15em;font-weight:900;te...", disabled: false },
    { scriptName: "FF5 - Universal Dialogue Colorizer", findRegex: "/<\\s{0,8}(?:color\\s{0,8}:\\s{0,8})?(cyan|pink|teal|orange|gold|violet|salmon|orchid|yellow|plum)\\s{0,8}>([“\"][^”\"]{1,2000}?[”\"])(?:\\s{0,8}<\\s{0,8}\\/\\s{0,8}[^<>\\n\\r]{0,40}>|\\s{0,8}<\\s{0,8}\\/\\s{0,8}[a-zA-Z0-9_-]{0,24}:|\\s{0,8}\\1>)?/gi", replaceString: "<span style=\"color:$1;\">$2</span>", disabled: false },
    { scriptName: "Hapuppy Delete Thoughts", findRegex: "/(?:<\\s{0,8}(?:think|thinking|thought|thoughts|reasoning|internal_monologue|internal\\s+monologue)\\b[^>]{0,120}>[\\s\\S]{0,20000}?<\\s{0,8}\\/\\s{0,8}(?:think|thinking|thought|thoughts|reasoning|internal_monologue|internal\\s+monologue)[^>]{0,120}>|###\\s{0,8}(?:Internal Monologue|Reasoning|Thoughts?|Thinking)\\s{0,8}[\\s\\S]{0,20000}?###\\s{0,8}(?:Response|Output|Narrative|Final Answer)\\s{0,8})/gi", replaceString: "", disabled: false },
    { scriptName: "Hapuppy Hide Thoughts", findRegex: "/(?:<\\s{0,8}(think|thinking|thought|thoughts|reasoning|internal_monologue|internal\\s+monologue)\\b[^>]{0,120}>([\\s\\S]{0,20000}?)<\\s{0,8}\\/\\s{0,8}\\1[^>]{0,120}>|###\\s{0,8}(?:Internal Monologue|Reasoning|Thoughts?|Thinking)\\s{0,8}\\n?([\\s\\S]{0,20000}?)###\\s{0,8}(?:Response|Output|Narrative|Final Answer)\\s{0,8})/gi", replaceString: "<details style=\"background: rgba(147, 51, 234, 0.08); bor...", disabled: false },
    { scriptName: "FF5 UI - Stack Bullets", findRegex: "/\\n[ \\t]{0,8}[-•*][ \\t]{0,8}<b>/g", replaceString: "<br>- <b>", disabled: false },
    { scriptName: "FF5 UI - Menu Master", findRegex: "/<details>\\s{0,8}<summary>([^<]{0,200}?)(INTERNAL STATES)([^<]{0,200}?)<\\/summary>/gi", replaceString: "<details style=\"background:rgba(20,20,30,0.4);border-radi...", disabled: false },
    { scriptName: "FF5 UI - Menu Purple", findRegex: "/<details>\\s{0,8}<summary>([^<]{0,200}?)(QUESTS|CHEKHOV'S GUN|CHEKHOV SEEDS|INTERNAL THOUGHTS|INV & SKILLS|INVENTORY & STATUS|GM NOTEBOOK|GM'S NOTEBOOK)([^<]{0,200}?)<\\/summary>([\\s\\S]{0,20000}?)<\\/details>/gi", replaceString: "<details style=\"background:rgba(203,166,247,0.05);border:...", disabled: false },
    { scriptName: "FF5 UI - Menu Teal", findRegex: "/<details>\\s{0,8}<summary>([^<]{0,200}?)(NPC AGENDAS|NPC LOCATIONS|FACTIONS|BONDS|BOND TRACKER)([^<]{0,200}?)<\\/summary>([\\s\\S]{0,20000}?)<\\/details>/gi", replaceString: "<details style=\"background:rgba(148,226,213,0.05);border:...", disabled: false },
    { scriptName: "FF5 UI - Menu Orange", findRegex: "/<details>\\s{0,8}<summary>([^<]{0,200}?)(PLOT MOMENTUM|DND TASK SIM|WORLD SIM|PHYSICS, ENGINE & WORLD)([^<]{0,200}?)<\\/summary>([\\s\\S]{0,20000}?)<\\/details>/gi", replaceString: "<details style=\"background:rgba(250,179,135,0.05);border:...", disabled: false },
    { scriptName: "FF5 UI - Highlights", findRegex: "/-[ \\t]{0,8}<b[^>]{0,120}?>(.{0,400}?)<\\/b>(?![ \\t]{0,8}↔)/g", replaceString: "- <b style=\"color:#f9e2af;font-weight:600;text-shadow:0 0...", disabled: false },
    { scriptName: "FF5 UI - GM Notebook Highlights", findRegex: "/-[ \\t]{0,8}\\[([RTD])\\]/g", replaceString: "- <b style=\"color:#f9e2af;font-weight:600;text-shadow:0 0...", disabled: false },
    { scriptName: "FF5 - Relationship Bars (Positive)", findRegex: "/-?[ \\t]{0,8}(?:<b[^>]{0,120}>)?\\s{0,8}([^<|↔\\n]{1,80}?)\\s{0,8}(?:<\\/b>)?\\s{0,8}↔\\s{0,8}(?:<b[^>]{0,120}>)?\\s{0,8}([^<|\\n]{1,80}?)\\s{0,8}(?:<\\/b>)?\\s{0,8}\\|\\s{0,8}BOND:\\s{0,8}(\\+?)(\\d{1,6})\\s{0,8}\\|\\s{0,8}SPARKS?:\\s{0,8}(\\d{1,6})\\s{0,8}\\|\\s{0,8}GRUDGE:\\s{0,8}(\\d{1,6})/gi", replaceString: "<div style=\"background:rgba(24,24,37,0.8);border:1px soli...", disabled: false },
    { scriptName: "FF5 - Relationship Bars (Negative)", findRegex: "/-?[ \\t]{0,8}(?:<b[^>]{0,120}>)?\\s{0,8}([^<|↔\\n]{1,80}?)\\s{0,8}(?:<\\/b>)?\\s{0,8}↔\\s{0,8}(?:<b[^>]{0,120}>)?\\s{0,8}([^<|\\n]{1,80}?)\\s{0,8}(?:<\\/b>)?\\s{0,8}\\|\\s{0,8}BOND:\\s{0,8}(-)(\\d{1,6})\\s{0,8}\\|\\s{0,8}SPARKS?:\\s{0,8}(\\d{1,6})\\s{0,8}\\|\\s{0,8}GRUDGE:\\s{0,8}(\\d{1,6})/gi", replaceString: "<div style=\"background:rgba(24,24,37,0.8);border:1px soli...", disabled: false },
    { scriptName: "FF5 - GFX Stripper", findRegex: "/<!-- GFX_START -->\\s{0,8}<div[^>]{0,200}?>([\\s\\S]{0,20000}?)<\\/div>\\s{0,8}<!-- GFX_END -->/gi", replaceString: "$1", disabled: false },
    { scriptName: "FF5 - Image Prompt Stripper", findRegex: "/<!--\\s{0,8}IMG_PROMPT:[\\s\\S]{0,4000}?-->/gi", replaceString: "", disabled: false },
];

const FF54 = {
  name: 'Freaky Frankenstein 5.4 Internal States',
  prompts: FF54_PROMPTS,
  regex: FF54_REGEX,
};
