import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { probe, sampleFrames, frame } from '../engine/media.js';
import { ocrPool, readKda } from '../engine/analyzer.js';
import { DEFAULT_ROI } from '../engine/core.js';
const file = process.env.EOL_SAMPLE ?? path.resolve('src-video/예시녹화본1.mp4');
test(
  'real HUD regression: zero and italic 7/slash are recognized independently',
  { skip: !existsSync(file) },
  async () => {
    const pool = await ocrPool(2);
    try {
      for (const [time, expected] of [
        [120, [0, 0, 0]],
        [130, [0, 0, 0]],
        [600, [0, 0, 1]],
        [1515, [7, 2, 7]],
        [1740, [7, 3, 7]],
      ]) {
        const source = await probe(file, { in: time, out: time + 0.5 });
        for await (const f of sampleFrames(
          source,
          DEFAULT_ROI,
          0.5,
          new AbortController().signal,
        )) {
          assert.deepEqual((await readKda(pool, f.raw, f)).kda, expected, `raw frame ${time}`);
        }
        assert.deepEqual(
          (await readKda(pool, await frame(source, time, DEFAULT_ROI))).kda,
          expected,
          `preview frame ${time}`,
        );
      }
    } finally {
      await pool.terminate();
    }
  },
);
