// Asks Codex (built-in image_gen) for a raw image per asset, then pixelizes it.
// Usage: node tools/gen-art.js [assetId] [--force]
// Env: CODEX_BIN, LBL_CODEX_MODEL (orchestrating model; it only has to make one tool call).
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pixelize } from './pixelize.js';

const CODEX_HOME = process.env.CODEX_HOME ?? path.join(os.homedir(), '.codex');
const CODEX = process.env.CODEX_BIN ??
  path.join(CODEX_HOME, 'packages/standalone/releases/0.166.0-x86_64-pc-windows-msvc/bin/codex.exe');
const MODEL = process.env.LBL_CODEX_MODEL ?? 'gpt-6-luna';
const style = fs.readFileSync('art/style.md', 'utf8');
const assets = JSON.parse(fs.readFileSync('art/assets.json', 'utf8'));
const force = process.argv.includes('--force');
const only = process.argv.slice(2).find((a) => !a.startsWith('--'));
// An approved sprite becomes the style anchor for everything generated after it.
const STYLE_REF = 'art/preview/lbl_naked.png';

function imagePrompt(a, useRef) {
  return [
    useRef ? 'The attached image is the style reference: match its pixel scale, outline, palette and shading exactly.' : '',
    style,
    a.key
      ? `The object must be exactly ${a.size[0]} art-pixels wide and ${a.size[1]} art-pixels tall including its outline, drawn as large uniform square blocks of identical size.`
      : `The whole canvas is exactly ${a.size[0]}x${a.size[1]} art-pixels, drawn as large uniform square blocks of identical size.`,
    'Square 1:1 canvas.',
    `Asset: ${a.prompt}`,
  ].filter(Boolean).join('\n');
}

// Every extra agent round re-sends ~15k+ tokens of context, so the instructions aim for
// exactly two rounds: one image_gen call, one short reply. We fetch the file ourselves.
function agentPrompt(a, useRef) {
  return [
    'Call your built-in image generation tool exactly once, immediately, passing the IMAGE PROMPT below verbatim' +
      (useRef ? ' together with the attached reference image' : '') + '.',
    'Do not read any files or skills, do not run shell commands, do not wait or poll, do not inspect or describe the result.',
    'When the tool returns, reply with the single word DONE.',
    '',
    'IMAGE PROMPT:',
    imagePrompt(a, useRef),
  ].join('\n');
}

function runCodex(a, useRef) {
  const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '-s', 'read-only',
    '-m', MODEL, '-c', 'model_reasoning_effort="low"', '-C', process.cwd()];
  if (useRef) args.push('-i', STYLE_REF);
  args.push('-');
  const r = spawnSync(CODEX, args, { input: agentPrompt(a, useRef), encoding: 'utf8', maxBuffer: 64 << 20 });
  const events = r.stdout.split('\n').filter(Boolean).flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } });
  const thread = events.find((e) => e.type === 'thread.started')?.thread_id;
  const usage = events.findLast((e) => e.type === 'turn.completed')?.usage;
  if (r.status !== 0 || !thread) process.stderr.write(r.stderr.slice(-2000));
  return { thread, usage };
}

function newestImage(thread) {
  const dir = path.join(CODEX_HOME, 'generated_images', thread);
  if (!fs.existsSync(dir)) return null;
  const pngs = fs.readdirSync(dir).filter((f) => f.endsWith('.png'))
    .map((f) => path.join(dir, f)).sort((x, y) => fs.statSync(y).mtimeMs - fs.statSync(x).mtimeMs);
  return pngs[0] ?? null;
}

fs.mkdirSync('art/raw', { recursive: true });

for (const a of assets) {
  if (only && a.id !== only) continue;
  const out = `art/raw/${a.id}.png`;
  if (fs.existsSync(out) && !force) { console.log(`skip ${a.id} (raw exists; --force to regenerate)`); continue; }
  // Tiles must not inherit a character's outline and side shading, so only sprites get the reference.
  const useRef = a.key && a.id !== 'lbl_naked' && fs.existsSync(STYLE_REF);

  const t0 = Date.now();
  console.log(`generating ${a.id} with ${MODEL} ...`);
  const { thread, usage } = runCodex(a, useRef);
  const img = thread && newestImage(thread);
  if (!img) { console.error(`codex produced no image for ${a.id}`); continue; }
  fs.copyFileSync(img, out);
  if (usage) console.log(`  ${((Date.now() - t0) / 1000).toFixed(0)}s, tokens in ${usage.input_tokens} ` +
    `(cached ${usage.cached_input_tokens}) out ${usage.output_tokens}`);
  await pixelize(a);
}
