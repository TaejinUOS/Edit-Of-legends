import path from 'node:path';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { bin, probe } from '../engine/media.js';
import { defaultKdaRoi, flashOptions, roiPixels } from '../engine/core.js';

const file = process.argv[2];
const seconds = Number(process.argv[3] ?? 300);
if (!file || !Number.isFinite(seconds) || seconds <= 0) {
  console.error('Usage: node scripts/profile-filter-order.js <video> [seconds]');
  process.exit(1);
}
const source = await probe(path.resolve(file), { out: seconds });
const rois = [defaultKdaRoi(source), flashOptions({ slot: 'F' }, source).roi];
const regions = rois.map((roi) => roiPixels(roi, source.width, source.height));
const height = Math.max(...regions.map((r) => r.height));
const original =
  `[0:v]fps=2:start_time=0:round=up,format=gray,split=2[s0][s1];` +
  regions
    .map((r, i) => `[s${i}]crop=${r.width}:${r.height}:${r.x}:${r.y},pad=${r.width}:${height}:0:0[c${i}]`)
    .join(';') +
  ';[c0][c1]hstack=inputs=2[hud]';
const optimized =
  `[0:v]fps=2:start_time=0:round=up,split=2[s0][s1];` +
  regions
    .map((r, i) => `[s${i}]crop=${r.width}:${r.height}:${r.x}:${r.y}:exact=1,extractplanes=y,lut=y='(val-16)*255/219+0.5',pad=${r.width}:${height}:0:0[c${i}]`)
    .join(';') +
  ';[c0][c1]hstack=inputs=2[hud]';

async function trial(name, filter) {
  const start = performance.now();
  const args = [
    '-hide_banner', '-loglevel', 'error', '-threads', '4', '-ss', String(source.in),
    '-i', source.path, '-t', String(source.out - source.in), '-an', '-filter_threads', '1',
    '-filter_complex_threads', '1', '-filter_complex', filter, '-map', '[hud]',
    '-f', 'rawvideo', '-pix_fmt', 'gray', '-threads', '1', 'pipe:1',
  ];
  const child = spawn(bin('ffmpeg'), args, {
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const hash = createHash('sha256');
  let bytes = 0;
  const chunks = [];
  let error = '';
  child.stdout.on('data', (part) => { bytes += part.length; hash.update(part); chunks.push(part); });
  child.stderr.on('data', (part) => { error = (error + part).slice(-4000); });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) throw new Error(`${name}: ffmpeg exited ${code}: ${error}`);
  console.log(JSON.stringify({
    name, elapsedMs: Math.round(performance.now() - start), bytes,
    sha256: hash.digest('hex'),
  }));
  return Buffer.concat(chunks);
}

console.log(JSON.stringify({ video: source.name, seconds, threads: 4 }));
const baseline = await trial('original', original);
const candidate = await trial('optimized', optimized);
console.log(JSON.stringify({ name: 'matchesOriginal', value: candidate.equals(baseline) }));
