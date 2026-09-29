import { inflateSync, strFromU8, unzipSync } from 'fflate';
import type { ParsedCard } from './types';

/** A card with no name cannot be filed, so it is an error rather than a default. */
export class CardParseError extends Error {}

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];
const ZIP_MAGIC = [0x50, 0x4b, 0x03, 0x04];

/**
 * Dispatch by magic bytes, never by file extension: exporters hand out files whose
 * extension lies, and a `.png` that is really a ZIP is common.
 */
export async function parseCardFile(file: File): Promise<ParsedCard> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  if (startsWith(bytes, PNG_MAGIC)) return parsePngCard(bytes);
  if (startsWith(bytes, ZIP_MAGIC)) return parseZipCard(bytes);
  return parseJsonCard(new TextDecoder().decode(bytes), 'ccv2');
}

export function parsePngCard(bytes: Uint8Array): ParsedCard {
  const texts = readPngTextChunks(bytes);
  // `ccv3` takes precedence over `chara` when both are present.
  const ccv3 = texts.get('ccv3');
  const chara = texts.get('chara');
  const chosen = ccv3 ?? chara;
  if (!chosen) {
    throw new CardParseError('PNG has no `chara` or `ccv3` text chunk — not a character card.');
  }
  return parseJsonCard(decodeCardText(chosen), ccv3 ? 'ccv3' : 'ccv2');
}

/**
 * Most cards store the JSON base64-encoded in the text chunk, but some exporters
 * write it raw, and nothing in the chunk signals which. Try the JSON reading first:
 * it is unambiguous, and base64 never starts with `{`.
 */
function decodeCardText(text: string): string {
  const trimmed = text.trim();
  return trimmed.startsWith('{') ? trimmed : base64ToUtf8(trimmed);
}

function parseZipCard(bytes: Uint8Array): ParsedCard {
  const entries = unzipSync(bytes);
  const cardEntry = Object.keys(entries).find((name) => name.replace(/^\.\//, '') === 'card.json');
  if (!cardEntry) throw new CardParseError('CharX archive has no `card.json` at its root.');
  return parseJsonCard(strFromU8(entries[cardEntry]), 'charx');
}

export function parseJsonCard(json: string, format: ParsedCard['sourceFormat']): ParsedCard {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new CardParseError('Card payload is not valid JSON.');
  }
  if (!raw || typeof raw !== 'object') throw new CardParseError('Card payload is not an object.');

  const envelope = raw as Record<string, unknown>;
  const spec = typeof envelope.spec === 'string' ? envelope.spec : '';
  // Unwrapping the envelope is step one; mapping every field below is step two.
  // Dropping `creator_notes`, `tags`, or `alternate_greetings` here is the known bug.
  const inner =
    envelope.data && typeof envelope.data === 'object'
      ? (envelope.data as Record<string, unknown>)
      : envelope;

  // The container is what the user actually handed us, and a CharX archive is a
  // distinct thing from a bare v2 JSON — reporting `ccv2` for it would erase that.
  // Only a bare JSON/PNG reports the spec version inside.
  const sourceFormat: ParsedCard['sourceFormat'] =
    format === 'charx' ? 'charx' : spec.includes('v3') ? 'ccv3' : 'ccv2';

  const name = str(inner.name);
  if (name.length === 0) throw new CardParseError('Card has no `name`.');

  return {
    name,
    description: str(inner.description),
    personality: str(inner.personality),
    scenario: str(inner.scenario),
    firstMes: str(inner.first_mes),
    mesExample: str(inner.mes_example),
    systemPrompt: str(inner.system_prompt),
    postHistoryInstructions: str(inner.post_history_instructions),
    alternateGreetings: strArray(inner.alternate_greetings),
    creatorNotes: str(inner.creator_notes),
    tags: strArray(inner.tags),
    characterBook:
      inner.character_book && typeof inner.character_book === 'object' ? inner.character_book : null,
    avatarHint: str(inner.avatar) || null,
    ...(sourceFormat === 'ccv3' || inner.nickname !== undefined
      ? { nickname: str(inner.nickname) }
      : {}),
    ...(inner.creator_notes_multilingual !== undefined
      ? { creatorNotesMultilingual: inner.creator_notes_multilingual }
      : {}),
    sourceFormat,
    raw,
  };
}

/**
 * Walk PNG chunks by hand rather than with `png-chunks-extract`, which throws on a
 * CRC mismatch and demands an IEND. Cards exported by third-party tools are not
 * always byte-perfect, and a text chunk we can read is worth more than a CRC we
 * cannot verify. Handles tEXt, zTXt, and iTXt.
 */
function readPngTextChunks(bytes: Uint8Array): Map<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out = new Map<string, string>();
  let offset = 8;

  while (offset + 8 <= bytes.length) {
    const length = view.getUint32(offset);
    const type = String.fromCharCode(
      bytes[offset + 4],
      bytes[offset + 5],
      bytes[offset + 6],
      bytes[offset + 7],
    );
    const dataStart = offset + 8;
    if (dataStart + length > bytes.length) break;
    const data = bytes.subarray(dataStart, dataStart + length);

    if (type === 'IEND') break;
    if (type === 'tEXt' || type === 'zTXt' || type === 'iTXt') {
      const parsed = decodeTextChunk(type, data);
      if (parsed) out.set(parsed.keyword, parsed.text);
    }

    offset = dataStart + length + 4; // skip CRC
  }

  return out;
}

function decodeTextChunk(
  type: string,
  data: Uint8Array,
): { keyword: string; text: string } | null {
  const keywordEnd = data.indexOf(0);
  if (keywordEnd <= 0) return null;
  const keyword = latin1(data.subarray(0, keywordEnd));

  if (type === 'tEXt') return { keyword, text: latin1(data.subarray(keywordEnd + 1)) };

  if (type === 'zTXt') {
    // keyword \0 compressionMethod(1) compressedText
    const compressed = data.subarray(keywordEnd + 2);
    try {
      return { keyword, text: new TextDecoder().decode(inflateSync(compressed)) };
    } catch {
      return null;
    }
  }

  // iTXt: keyword \0 compressionFlag(1) compressionMethod(1) languageTag \0 translatedKeyword \0 text
  const compressionFlag = data[keywordEnd + 1];
  const rest = data.subarray(keywordEnd + 3);
  const langEnd = rest.indexOf(0);
  if (langEnd < 0) return null;
  const afterLang = rest.subarray(langEnd + 1);
  const translatedEnd = afterLang.indexOf(0);
  if (translatedEnd < 0) return null;
  const text = afterLang.subarray(translatedEnd + 1);
  try {
    return {
      keyword,
      text: new TextDecoder().decode(compressionFlag ? inflateSync(text) : text),
    };
  } catch {
    return null;
  }
}

function latin1(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += String.fromCharCode(bytes[i]);
  return out;
}

function base64ToUtf8(base64: string): string {
  const binary = atob(base64.replace(/\s+/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function startsWith(bytes: Uint8Array, magic: number[]): boolean {
  if (bytes.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (bytes[i] !== magic[i]) return false;
  return true;
}

function str(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function strArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((entry): entry is string => typeof entry === 'string');
}
