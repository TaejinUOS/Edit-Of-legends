import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  DEFAULT_ROI,
  DEFAULT_ROI_1080,
  defaultKdaRoi,
  resolveKdaRoi,
  cacheKey,
  flashOptions,
  FLASH_ROIS,
  FLASH_ROIS_1080,
} from '../engine/core.js';
import { readFlash } from '../engine/flash.js';
import { ocrPool, readKda } from '../engine/analyzer.js';

test('KDA defaults return to the original crop and migrate the shifted 1080p preset', () => {
  const source = { width: 1920, height: 1080 };
  assert.deepEqual(defaultKdaRoi(source), DEFAULT_ROI);
  assert.deepEqual(defaultKdaRoi({ width: 2560, height: 1440 }), DEFAULT_ROI);
  assert.deepEqual(resolveKdaRoi(source, { ...DEFAULT_ROI_1080, height: 2.2 / 100 }), DEFAULT_ROI);
  assert.deepEqual(resolveKdaRoi(source, DEFAULT_ROI), DEFAULT_ROI);
  const custom = { ...DEFAULT_ROI, x: 0.84 };
  assert.deepEqual(resolveKdaRoi(source, custom), custom);
  assert.notEqual(cacheKey(source, DEFAULT_ROI, 0.5), cacheKey(source, DEFAULT_ROI_1080, 0.5));
  assert.deepEqual(flashOptions({ slot: 'F', roi: FLASH_ROIS.F }, source).roi, FLASH_ROIS_1080.F);
  assert.deepEqual(flashOptions({ slot: 'D' }, source).roi, FLASH_ROIS_1080.D);
  const customFlash = { ...FLASH_ROIS.F, x: 0.54 };
  assert.deepEqual(flashOptions({ roi: customFlash }, source).roi, customFlash);
});

test('real 1080p multi-HUD crops retain all three KDA values', async () => {
  const pool = await ocrPool();
  try {
    for (const [time, state, cooldown] of [
      [120, 'ready', null],
      [900, 'cooldown', 144],
    ]) {
      const image = await readFile(
        new URL(`./fixtures/kda-1080/flash-${time}.png`, import.meta.url),
      );
      const value = await readFlash(pool, image);
      assert.equal(value.state, state);
      assert.equal(value.cooldown, cooldown);
    }
    for (const [time, expected] of [
      [120, [0, 0, 0]],
      [600, [1, 2, 1]],
      [1200, [1, 4, 6]],
      [1450, [2, 4, 8]],
    ]) {
      const image = await readFile(new URL(`./fixtures/kda-1080/${time}.png`, import.meta.url));
      assert.deepEqual((await readKda(pool, image)).kda, expected, `source ${time}s`);
    }
  } finally {
    await pool.terminate();
  }
});
