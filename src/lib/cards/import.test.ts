import { describe, expect, test } from 'bun:test';
import { deflateSync, zipSync } from 'fflate';
import { CardParseError, parseCardFile, parseJsonCard, parsePngCard } from './import';

/**
 * The card shape every fixture below encodes. `creator_notes`, `tags`, and
 * `alternate_greetings` are the fields the known import bug drops, so every fixture
 * carries non-empty values for all three and every format is asserted against the
 * same expected mapping.
 */
const V2_CARD = {
  spec: 'chara_card_v2',
  spec_version: '2.0',
  data: {
    name: 'Ada',
    description: 'A cartographer.',
    personality: 'Dry.',
    scenario: 'A tavern.',
    first_mes: 'You are late.',
    mes_example: '<START>\n{{user}}: hi\n{{char}}: hello',
    system_prompt: 'Stay in character.',
    post_history_instructions: 'Never break character.',
    alternate_greetings: ['A second opening.', 'A third opening.'],
    creator_notes: 'Made for a test.',
    tags: ['cartographer', 'tavern'],
    character_book: { entries: [{ id: 0, keys: ['tavern'], content: 'The Compass Rose.' }] },
  },
};

const V3_CARD = {
  spec: 'chara_card_v3',
  spec_version: '3.0',
  data: {
    ...V2_CARD.data,
    nickname: 'Addie',
    creator_notes_multilingual: { ja: 'テスト' },
  },
};

describe('card import', () => {
  test('unwraps the v2 envelope and maps every field, not just the visible ones', () => {
    const card = parseJsonCard(JSON.stringify(V2_CARD), 'ccv2');
    expect(card.name).toBe('Ada');
    expect(card.sourceFormat).toBe('ccv2');
    // The known failure class: these are the fields that get dropped.
    expect(card.creatorNotes).toBe('Made for a test.');
    expect(card.tags).toEqual(['cartographer', 'tavern']);
    expect(card.alternateGreetings).toEqual(['A second opening.', 'A third opening.']);
    expect(card.characterBook).not.toBeNull();
    // The rest of the map.
    expect(card.postHistoryInstructions).toBe('Never break character.');
    expect(card.systemPrompt).toBe('Stay in character.');
    expect(card.mesExample).toContain('{{char}}: hello');
    expect(card.firstMes).toBe('You are late.');
  });

  test('maps v3-only fields when the spec says v3', () => {
    const card = parseJsonCard(JSON.stringify(V3_CARD), 'ccv3');
    expect(card.sourceFormat).toBe('ccv3');
    expect(card.nickname).toBe('Addie');
    expect(card.creatorNotesMultilingual).toEqual({ ja: 'テスト' });
    expect(card.creatorNotes).toBe('Made for a test.');
  });

  test('accepts a bare card with no envelope', () => {
    const card = parseJsonCard(
      JSON.stringify({ name: 'Bare', description: 'd', tags: ['x'], creator_notes: 'n' }),
      'ccv2',
    );
    expect(card.name).toBe('Bare');
    expect(card.tags).toEqual(['x']);
    expect(card.creatorNotes).toBe('n');
  });

  test('rejects a card with no name rather than defaulting it', () => {
    expect(() => parseJsonCard(JSON.stringify({ description: 'no name' }), 'ccv2')).toThrow(
      CardParseError,
    );
  });

  test('defaults absent fields to empty rather than undefined', () => {
    const card = parseJsonCard(JSON.stringify({ name: 'Minimal' }), 'ccv2');
    expect(card.description).toBe('');
    expect(card.tags).toEqual([]);
    expect(card.alternateGreetings).toEqual([]);
    expect(card.characterBook).toBeNull();
  });

  test('reads a PNG tEXt chara chunk', () => {
    const png = buildPng([{ keyword: 'chara', text: base64(V2_CARD) }]);
    const card = parsePngCard(png);
    expect(card.name).toBe('Ada');
    expect(card.tags).toEqual(['cartographer', 'tavern']);
    expect(card.creatorNotes).toBe('Made for a test.');
  });

  test('prefers a ccv3 chunk over chara when both are present', () => {
    const png = buildPng([
      { keyword: 'chara', text: base64(V2_CARD) },
      { keyword: 'ccv3', text: base64(V3_CARD) },
    ]);
    const card = parsePngCard(png);
    expect(card.sourceFormat).toBe('ccv3');
    expect(card.nickname).toBe('Addie');
  });

  test('reads a compressed zTXt chunk', () => {
    const json = JSON.stringify(V2_CARD);
    const png = buildPng([{ keyword: 'chara', text: json, compress: true }]);
    expect(parsePngCard(png).name).toBe('Ada');
  });

  test('rejects a PNG with no card chunk', () => {
    const png = buildPng([{ keyword: 'Comment', text: 'not a card' }]);
    expect(() => parsePngCard(png)).toThrow(CardParseError);
  });

  test('dispatches by magic bytes, not extension', async () => {
    const png = buildPng([{ keyword: 'chara', text: base64(V2_CARD) }]);
    // Named `.json` but is really a PNG — the extension must not decide.
    const asPng = await parseCardFile(new File([png], 'card.json'));
    expect(asPng.name).toBe('Ada');

    const zip = buildCharx(V3_CARD);
    const asZip = await parseCardFile(new File([zip], 'card.json'));
    expect(asZip.name).toBe('Ada');
    // The container is reported, not the spec version inside it.
    expect(asZip.sourceFormat).toBe('charx');
    expect(asZip.nickname).toBe('Addie');

    const plain = await parseCardFile(new File([JSON.stringify(V2_CARD)], 'card.png'));
    expect(plain.name).toBe('Ada');
  });

  test('reads card.json from a CharX archive root', async () => {
    const zip = buildCharx(V2_CARD);
    const card = await parseCardFile(new File([zip], 'card.charx'));
    expect(card.sourceFormat).toBe('charx');
    expect(card.creatorNotes).toBe('Made for a test.');
    expect(card.alternateGreetings).toHaveLength(2);
  });
});

function base64(value: unknown): string {
  const bytes = new TextEncoder().encode(JSON.stringify(value));
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

/** Minimal PNG writer: signature, IHDR, text chunks, IEND. Enough to be a real PNG. */
function buildPng(
  chunks: Array<{ keyword: string; text: string; compress?: boolean }>,
): Uint8Array<ArrayBuffer> {
  const parts: Uint8Array[] = [
    new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0])),
  ];

  for (const entry of chunks) {
    const keyword = new TextEncoder().encode(entry.keyword);
    const text = new TextEncoder().encode(entry.text);
    let payload: Uint8Array;
    if (entry.compress) {
      payload = concat(keyword, new Uint8Array([0, 0]), deflateSync(text));
    } else {
      payload = concat(keyword, new Uint8Array([0]), text);
    }
    parts.push(chunk(entry.compress ? 'zTXt' : 'tEXt', payload));
  }

  parts.push(chunk('IEND', new Uint8Array(0)));
  return concat(...parts);
}

function buildCharx(card: unknown): Uint8Array<ArrayBuffer> {
  return zipSync({
    'card.json': new TextEncoder().encode(JSON.stringify(card)),
    'assets/avatar.png': new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  });
}

function chunk(type: string, data: Uint8Array): Uint8Array<ArrayBuffer> {
  const length = new Uint8Array(4);
  new DataView(length.buffer).setUint32(0, data.length);
  const typeBytes = new TextEncoder().encode(type);
  // CRC is not verified by the reader, so a placeholder keeps the writer small.
  return concat(length, typeBytes, data, new Uint8Array(4));
}

function concat(...arrays: Uint8Array[]): Uint8Array<ArrayBuffer> {
  let total = 0;
  for (const array of arrays) total += array.length;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const array of arrays) {
    out.set(array, offset);
    offset += array.length;
  }
  return out;
}
