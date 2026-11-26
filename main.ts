// radar-score v3 — entry point.
//
// Reads the sealed snapshot, scores the whole pre-token universe, writes the
// board and the dashboard data file, copies the page and screenshots into the
// output tree, and finishes with the dossier the judge actually reads.
//
// Grader shape: the snapshot arrives at /input/snapshot.json and the outputs
// land in /output. For a local run, pass --input <file|dir> and
// MAKEFUN_OUTPUT_DIR=<dir>.

import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boardFault, buildBoard, dataPayload, parseSnapshotDoc, radarDoc, type BoardLine, type RadarDoc } from './lib/model.ts';
import { buildDossier } from './vendor/makefun-board.ts';

const root = fileURLToPath(new URL('.', import.meta.url));
const DOSSIER_TEXT_CAP = 65_536;
const SHOT_CAPS = { max: 4, max_bytes: 524_288 };
const IMAGE_FILE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;

function flagValue(name: string, fallback: string): string {
  const pos = process.argv.indexOf(`--${name}`);
  if (pos >= 0 && pos + 1 < process.argv.length) return process.argv[pos + 1]!;
  const eq = process.argv.find((a) => a.startsWith(`--${name}=`));
  return eq === undefined ? fallback : eq.slice(name.length + 3);
}

const inputArg = flagValue('input', '/input');
const snapshotFile = inputArg.endsWith('.json') ? inputArg : join(inputArg, 'snapshot.json');
if (!existsSync(snapshotFile)) {
  process.stderr.write(`radar-score: cannot find ${snapshotFile} — pass --input <snapshot.json|dir> or mount the sealed /input\n`);
  process.exit(2);
}
const outDir = flagValue('output', process.env.MAKEFUN_OUTPUT_DIR ?? '/output');

const doc = parseSnapshotDoc(readFileSync(snapshotFile, 'utf8'));
// The blind test decides which value terms earn their place; the board is then
// scored with the kept set, and the dropped ones are zeroed in the record.
const probe = radarDoc(doc, buildBoard(doc));
const scored = probe.scored_params;
const board = buildBoard(doc, scored);
const fault = boardFault(board, doc);
if (fault !== null) {
  process.stderr.write(`radar-score: the board fails its own gate: ${fault}\n`);
  process.exit(1);
}
const radar: RadarDoc = radarDoc(doc, board, scored);

mkdirSync(outDir, { recursive: true });
writeFileSync(join(outDir, 'board.json'), `${JSON.stringify({ rows: board })}\n`);
writeFileSync(join(outDir, 'data.js'), dataPayload(radar));

function mirrorTree(src: string, dst: string): number {
  if (!existsSync(src)) return 0;
  let n = 0;
  for (const name of readdirSync(src)) {
    if (name.startsWith('.')) continue;
    const from = join(src, name);
    const to = join(dst, name);
    if (statSync(from).isDirectory()) {
      n += mirrorTree(from, to);
    } else if (IMAGE_FILE.test(name)) {
      mkdirSync(dst, { recursive: true });
      copyFileSync(from, to);
      n += 1;
    }
  }
  return n;
}
const shots = mirrorTree(join(root, 'dashboard'), join(outDir, 'dashboard'));
const pics = mirrorTree(join(root, 'screenshots'), join(outDir, 'screenshots'));

const dossier = buildDossier(outDir, {
  text_max_bytes: DOSSIER_TEXT_CAP,
  screenshots: SHOT_CAPS,
  dashboard: { max_files: 400, max_bytes: 4_194_304 },
});
writeFileSync(join(outDir, 'dossier.json'), dossier);

const below = board.filter((r) => !doc.watchlist.includes(r.slug)).length;
process.stderr.write(`radar-score: ${doc.protocols.length} protocols scanned, ${doc.watchlist.length} watchlist, ${board.length} rows on the board (${below} below the floor), ${radar.live_count} live set aside\n`);
process.stderr.write(`radar-score: wrote board.json, data.js, dashboard/ (${shots} files), screenshots/ (${pics} images), dossier.json in ${basename(outDir)}\n`);
