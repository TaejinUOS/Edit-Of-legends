import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { probe, sampleFrames, frame } from '../engine/media.js';
import { ocrPool, readKda, readGameClock } from '../engine/analyzer.js';
import {
  DEFAULT_ROI,
  DEFAULT_CLOCK_ROI,
  FLASH_ROIS,
  detectOpeningWindow,
  planClips,
} from '../engine/core.js';
import { readFlash, detectFlashEvents } from '../engine/flash.js';
const file = process.env.EOL_SAMPLE ?? path.resolve('src-video/예시녹화본1.mp4');
test(
  'real video detects four F-flash transitions while sharing the KDA decode pass',
  { skip: !existsSync(file) },
  async () => {
    const pool = await ocrPool(2);
    try {
      for (const [start, end, expected] of [
        [283, 297, 291],
        [628, 640, 631],
        [1213, 1224, 1216.5],
        [1624, 1636, 1629.5],
      ]) {
        const source = await probe(file, { in: start, out: end });
        const samples = [];
        for await (const f of sampleFrames(source, [DEFAULT_ROI, FLASH_ROIS.F], 0.5)) {
          const [kda, flash] = f.regions;
          samples.push({ time: f.time, ...(await readFlash(pool, flash.raw, flash)) });
          if (f.time === start) assert.ok((await readKda(pool, kda.raw, kda)).kda);
        }
        const events = detectFlashEvents(samples);
        assert.equal(events.length, 1);
        assert.equal(events[0].time, expected);
        assert.equal(events[0].included, true);
      }
    } finally {
      await pool.terminate();
    }
  },
);
test(
  'real clock HUD locates the mandatory opening at source 2:13 through 4:53',
  { skip: !existsSync(file) },
  async () => {
    const source = await probe(file);
    const pool = await ocrPool();
    const samples = [];
    try {
      for (const [time, expected] of [
        [120, 37],
        [132, 49],
        [133, 50],
        [134, 51],
        [180, 97],
        [240, 157],
        [292, 209],
        [293, 210],
        [294, 211],
      ]) {
        const value = await readGameClock(pool, await frame(source, time, DEFAULT_CLOCK_ROI));
        assert.equal(value.clockSeconds, expected, `clock at source ${time}`);
        samples.push({ time, ...value });
      }
      const openingWindow = detectOpeningWindow(samples, source);
      assert.equal(openingWindow.in, 133);
      assert.equal(openingWindow.out, 293);
      for (const types of [[], ['kill', 'death', 'assist']]) {
        const plan = planClips(
          [
            { id: 'early', type: 'kill', time: 150, included: true, amount: 1 },
            { id: 'later', type: 'assist', time: 320, included: true, amount: 1 },
          ],
          { ...source, openingWindow },
          { types },
        );
        assert.equal(plan.clips[0].type, 'opening');
        assert.equal(plan.clips[0].in, 133);
        assert.equal(plan.clips[0].out, 293);
        assert.equal(plan.clips[0].outputInFrame, 0);
        assert.equal(plan.clips[0].outputOutFrame, 160 * 60);
        assert.equal(plan.clips.length, types.length ? 2 : 1);
      }
    } finally {
      await pool.terminate();
    }
  },
);
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
