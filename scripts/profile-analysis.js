import path from 'node:path';
import { performance } from 'node:perf_hooks';
import { probe, sampleFrames, verifyCfr } from '../engine/media.js';
import { analyze } from '../engine/analyzer.js';
import { defaultKdaRoi, DEFAULT_CLOCK_ROI, flashOptions } from '../engine/core.js';

const file = process.argv[2];
if (!file) {
  console.error('Usage: node scripts/profile-analysis.js <video>');
  process.exit(1);
}

const started = performance.now();
const stamp = () => Math.round(performance.now() - started);
const report = (name, begin, extra = {}) =>
  console.log(JSON.stringify({ name, elapsedMs: Math.round(performance.now() - begin), atMs: stamp(), ...extra }));

let begin = performance.now();
const source = await probe(path.resolve(file));
report('probe', begin);
begin = performance.now();
await verifyCfr(source);
report('verifyCfr', begin);

const roi = defaultKdaRoi(source);
const flash = flashOptions({ slot: 'F' }, source);
begin = performance.now();
let frames = 0;
for await (const _ of sampleFrames(source, [roi, flash.roi], 0.5, undefined, 4)) frames++;
report('decodeOnly', begin, { frames });

begin = performance.now();
let currentStage = null;
let stageStarted = begin;
const result = await analyze(
  source,
  { roi, clockRoi: DEFAULT_CLOCK_ROI, flash, workers: 'auto', interval: 0.5 },
  undefined,
  ({ stage }) => {
    if (stage === currentStage) return;
    const now = performance.now();
    if (currentStage) report(`stage:${currentStage}`, stageStarted);
    currentStage = stage;
    stageStarted = now;
    console.log(JSON.stringify({ name: `start:${stage}`, atMs: stamp() }));
  },
);
if (currentStage) report(`stage:${currentStage}`, stageStarted);
report('analyzeTotal', begin, {
  frames: result.sampleCount,
  readableRatio: result.readableRatio,
  events: result.events.length,
  decoderThreads: result.decoderThreads,
});
