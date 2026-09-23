import path from 'node:path';
import { spawn } from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { bin, probe, sampleFrames } from '../engine/media.js';
import { defaultKdaRoi, flashOptions, roiPixels } from '../engine/core.js';

const file = process.argv[2];
const seconds = Number(process.argv[3] ?? 300);
if (!file || !Number.isFinite(seconds) || seconds <= 0) {
  console.error('Usage: node scripts/profile-decode.js <video> [seconds]');
  process.exit(1);
}

const source = await probe(path.resolve(file), { out: seconds });
const rois = [defaultKdaRoi(source), flashOptions({ slot: 'F' }, source).roi];
const regions = rois.map((roi) => roiPixels(roi, source.width, source.height));
const width = regions.reduce((sum, r) => sum + r.width, 0);
const height = Math.max(...regions.map((r) => r.height));
const filter =
  `[0:v]fps=2:start_time=0:round=up,format=gray,split=2[s0][s1];` +
  regions
    .map((r, i) => `[s${i}]crop=${r.width}:${r.height}:${r.x}:${r.y},pad=${r.width}:${height}:0:0[c${i}]`)
    .join(';') +
  ';[c0][c1]hstack=inputs=2[hud]';
const common = [
  '-hide_banner', '-loglevel', 'error', '-threads', '4', '-ss', String(source.in),
  '-i', source.path, '-t', String(source.out - source.in), '-an', '-filter_threads', '1',
];

async function ffmpeg(name, args, stdout = 'ignore') {
  const start = performance.now();
  const child = spawn(bin('ffmpeg'), args, {
    windowsHide: true,
    stdio: ['ignore', stdout, 'pipe'],
  });
  let error = '';
  let bytes = 0;
  child.stderr.on('data', (part) => { error = (error + part).slice(-4000); });
  if (stdout === 'pipe') child.stdout.on('data', (part) => { bytes += part.length; });
  const code = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) throw new Error(`${name}: ffmpeg exited ${code}: ${error}`);
  console.log(JSON.stringify({ name, elapsedMs: Math.round(performance.now() - start), bytes }));
}

console.log(JSON.stringify({ video: source.name, seconds, threads: 4, samples: seconds * 2 }));
await ffmpeg('demuxCopy', [
  '-hide_banner', '-loglevel', 'error', '-ss', String(source.in), '-i', source.path,
  '-t', String(source.out - source.in), '-map', '0:v:0', '-an', '-c:v', 'copy', '-f', 'null', 'NUL',
]);
await ffmpeg('decodeAll', [...common, '-map', '0:v:0', '-f', 'null', 'NUL']);
await ffmpeg('decodeFps', [...common, '-vf', 'fps=2:start_time=0:round=up', '-f', 'null', 'NUL']);
const cropped = [...common, '-filter_complex_threads', '1', '-filter_complex', filter, '-map', '[hud]'];
await ffmpeg('decodeCrop', [...cropped, '-f', 'null', 'NUL']);
await ffmpeg('writeRawNull', [...cropped, '-f', 'rawvideo', '-pix_fmt', 'gray', '-threads', '1', 'NUL']);
await ffmpeg('pipeDrain', [...cropped, '-f', 'rawvideo', '-pix_fmt', 'gray', '-threads', '1', 'pipe:1'], 'pipe');
const start = performance.now();
let frames = 0;
for await (const _ of sampleFrames(source, rois, 0.5, undefined, 4)) frames++;
console.log(JSON.stringify({ name: 'sampleFrames', elapsedMs: Math.round(performance.now() - start), frames, bytes: frames * width * height }));
