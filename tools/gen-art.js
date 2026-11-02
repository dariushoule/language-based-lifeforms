// Asks Codex (built-in image_gen) for a raw image per asset, then pixelizes it.
// Usage: node tools/gen-art.js [assetId]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pixelize } from './pixelize.js';

const CODEX = process.env.CODEX_BIN ??
  path.join(os.homedir(), '.codex/packages/standalone/releases/0.166.0-x86_64-pc-windows-msvc/bin/codex.exe');
const style = fs.readFileSync('art/style.md', 'utf8');
const assets = JSON.parse(fs.readFileSync('art/assets.json', 'utf8'));
const only = process.argv[2];
// An approved sprite becomes the style anchor for everything generated after it.
const STYLE_REF = 'art/preview/lbl_naked.png';

fs.mkdirSync('art/raw', { recursive: true });

for (const a of assets) {
  if (only && a.id !== only) continue;
  const out = `art/raw/${a.id}.png`;
  const useRef = a.id !== 'lbl_naked' && fs.existsSync(STYLE_REF);
  const prompt = [
    'Use your built-in image generation tool (imagegen skill) to create exactly one image, then copy the generated PNG',
    `to ${out} in the current working directory. Do not edit or post-process the image. Reply only with the saved path.`,
    useRef ? 'The attached image is the style reference: match its pixel scale, outline, palette and shading exactly.' : '',
    '',
    style,
    a.key
      ? `The object must be exactly ${a.size[0]} art-pixels wide and ${a.size[1]} art-pixels tall including its outline, drawn as large uniform square blocks of identical size.`
      : `The whole canvas is exactly ${a.size[0]}x${a.size[1]} art-pixels, drawn as large uniform square blocks of identical size.`,
    'Square 1:1 canvas.',
    '',
    `Asset: ${a.prompt}`,
  ].join('\n');

  console.log(`generating ${a.id} ...`);
  const args = ['exec', '--skip-git-repo-check', '-s', 'workspace-write', '-C', process.cwd()];
  if (useRef) args.push('-i', STYLE_REF);
  args.push('-');
  const r = spawnSync(CODEX, args, { input: prompt, stdio: ['pipe', 'inherit', 'inherit'] });
  if (r.status !== 0 || !fs.existsSync(out)) { console.error(`codex failed for ${a.id}`); continue; }
  await pixelize(a);
}
