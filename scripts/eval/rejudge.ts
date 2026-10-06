/**
 * Judge-only pass: re-rates the SAVED transcripts from a completed eval run with a
 * different judge model, without regenerating a single turn.
 *
 * Why this exists: the first glm-5-3-flash judging attempt died at the 3600s shell
 * timeout — generation had finished for all 28 scenarios, but GLM judges each transcript
 * slower than DeepSeek does, and the run had completed only five ratings when the clock
 * ran out. Regenerating 112 turns to re-judge them would cost the same 13 minutes again
 * for prose we already have on disk.
 *
 * The input is `last-run.<tag>.md`, written by `run.ts`'s `transcriptSection`: one
 * `## <scenario>` block per result, each holding the full reader/narrator turns. Those
 * sections are parsed back out here and sent to `/api/eval/judge` — the same endpoint and
 * the same JUDGE_SYSTEM the harness uses, so the only variable that changes is the judge.
 *
 * Usage:
 *   bun run scripts/eval/rejudge.ts --in last-run.newrules.md --out RATINGS.glm.md
 * (reads .dev.vars for the token; the server must be running with the judge model
 * configured as cheapModel)
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { JUDGE_SYSTEM } from './rate';

const BASE = process.env.TESSERA_BASE ?? 'http://127.0.0.1:8787';

const flag = (name: string): string => {
  const argv = process.argv.slice(2);
  const at = argv.indexOf(name);
  return at >= 0 ? (argv[at + 1] ?? '') : '';
};

const IN = flag('--in') || 'last-run.newrules.md';
const OUT = flag('--out') || 'RATINGS.rejudged.md';

const TOKEN = (() => {
  const raw = readFileSync(new URL('../../.dev.vars', import.meta.url), 'utf8');
  const match = /^\s*TESSERA_TOKEN\s*=\s*(.*)$/m.exec(raw);
  if (!match) throw new Error('TESSERA_TOKEN not found in .dev.vars');
  return match[1].trim();
})();

interface Turn {
  reader: string;
  reply: string;
}

/**
 * One scenario section out of the transcript file. Sections are written by
 * `transcriptSection` with a predictable shape; parsing mirrors it rather than
 * re-deriving anything.
 */
function parseSections(markdown: string): Array<{ name: string; turns: Turn[] }> {
  const out: Array<{ name: string; turns: Turn[] }> = [];
  const blocks = markdown.split(/^## /m).slice(1);
  for (const block of blocks) {
    const name = block.split('\n')[0].trim().replace(/\s*—\s*`[^`]+`.*$/, '');
    // The transcript sections are separated from the header tables by the first
    // `### Turn` heading; everything after it is turn content.
    const body = block.slice(block.indexOf('\n') + 1);
    if (!/^### Turn/m.test(body)) continue;

    const turns: Turn[] = [];
    const chunks = body.split(/^### Turn \d+\s*$/m).slice(1);
    for (const chunk of chunks) {
      const readerMatch = /\*\*Reader:\*\* (.*?)\n\n\*\*Narrator:\*\*\n\n([\s\S]*?)(?=\n---\n|$)/.exec(chunk);
      if (!readerMatch) continue;
      turns.push({ reader: readerMatch[1].trim(), reply: readerMatch[2].trim() });
    }
    if (turns.length > 0) out.push({ name, turns });
  }
  return out;
}

async function judge(turns: Turn[]): Promise<string> {
  const parts: string[] = [];
  turns.forEach((turn, index) => {
    parts.push(`--- turn ${index + 1} ---`, `READER: ${turn.reader}`, `NARRATOR: ${turn.reply}`);
  });
  const res = await fetch(`${BASE}/api/eval/judge`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ system: JUDGE_SYSTEM, user: parts.join('\n\n') }),
  });
  if (!res.ok) throw new Error(`judge -> ${res.status} ${await res.text()}`);
  return (await res.json() as { text?: string; error?: string }).text ?? '';
}

const markdown = readFileSync(new URL(`./${IN}`, import.meta.url), 'utf8');
const sections = parseSections(markdown);
console.log(`judging ${sections.length} scenarios from ${IN} …\n`);

const lines = [
  '# Roleplay eval — rejudged ratings',
  '',
  `Source transcripts: \`${IN}\` (DeepSeek-v4.1-flash generation, unchanged).`,
  'Judge: the server-configured cheap model. Scores use the same eight dimensions and',
  'the same JUDGE_SYSTEM as `run.ts` — only the judge differs from the original run.',
  '',
];

for (const section of sections) {
  process.stdout.write(`  ${section.name} … `);
  try {
    const text = await judge(section.turns);
    lines.push(`## ${section.name}`, '', text.trim(), '');
    process.stdout.write('done\n');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    lines.push(`## ${section.name}`, '', `rating failed: ${message}`, '');
    process.stdout.write(`FAILED: ${message}\n`);
  }
}

const out = new URL(`./${OUT}`, import.meta.url);
writeFileSync(out, lines.join('\n'), 'utf8');
console.log(`\nwritten: ${out.pathname}`);
