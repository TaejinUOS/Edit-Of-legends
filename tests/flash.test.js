import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { ocrPool } from '../engine/analyzer.js';
import { readFlash, detectFlashEvents, parseCooldown } from '../engine/flash.js';
import { flashOptions, FLASH_ROIS, cacheKey, DEFAULT_ROI, planClips } from '../engine/core.js';

const ready = (time) => ({ time, state: 'ready', confidence: 95 });
const cd = (time, cooldown) => ({ time, state: 'cooldown', cooldown, confidence: 90 });
const unknown = (time) => ({ time, state: 'unknown', confidence: 0 });

test('flash requires readiness followed by a persistent decreasing cooldown', () => {
  const events = detectFlashEvents([
    cd(0, 200),
    cd(0.5, 200),
    cd(1, 199), // Already cooling down at the start.
    ready(2),
    ready(2.5),
    cd(3, 255),
    cd(3.5, 255),
    cd(4, 254),
    cd(4.5, 254),
    cd(5, 253), // No duplicate during the same cooldown.
    ready(300),
    ready(300.5),
    cd(301, 255),
    cd(301.5, 255),
    cd(302, 254),
  ]);
  assert.deepEqual(
    events.map((e) => e.time),
    [3, 301],
  );
  assert.ok(events.every((e) => e.included && !e.review));
  assert.equal(new Set(events.map((e) => e.id)).size, 2);
  assert.deepEqual(detectFlashEvents([ready(0), ready(0.5), unknown(1), unknown(1.5)]), []);
  assert.deepEqual(detectFlashEvents([ready(0), ready(0.5), cd(1, 255), ready(1.5)]), []);
  assert.deepEqual(
    detectFlashEvents([ready(0), ready(0.5), cd(1, 255), cd(1.5, 255), cd(2, 255)]),
    [],
  );
  assert.deepEqual(detectFlashEvents([ready(0), ready(0.5), cd(1, 10), cd(1.5, 10), cd(2, 9)]), []);
  assert.deepEqual(
    detectFlashEvents([ready(0), unknown(0.5), ready(1), cd(1.5, 255), cd(2, 254), cd(2.5, 254)]),
    [],
  );
});

test('occlusion makes the first observed cooldown a review candidate, not an invented use time', () => {
  const [event] = detectFlashEvents([
    ready(0),
    ready(0.5),
    unknown(1),
    cd(10, 245),
    cd(10.5, 245),
    cd(11, 244),
  ]);
  assert.equal(event.time, 10);
  assert.equal(event.included, false);
  assert.equal(event.review, true);
  assert.deepEqual(event.range, [0.5, 10]);
});

test('F is default; slot, ROI and disabled analysis have distinct cache keys', () => {
  assert.deepEqual(flashOptions(), { enabled: true, slot: 'F', roi: FLASH_ROIS.F });
  assert.deepEqual(flashOptions({ slot: 'D' }).roi, FLASH_ROIS.D);
  assert.throws(() => flashOptions({ slot: 'Q' }));
  assert.throws(() => flashOptions({ enabled: 'false' }));
  assert.throws(() => flashOptions({ roi: { x: 1, y: 0, width: 0.1, height: 0.1 } }));
  const key = (flash) => cacheKey({ path: 'sample.mp4' }, DEFAULT_ROI, 0.5, undefined, flash);
  assert.notEqual(key(), key({ slot: 'D' }));
  assert.notEqual(key(), key({ enabled: false }));
  assert.notEqual(key(), key({ roi: { ...FLASH_ROIS.F, x: 0.53 } }));
  assert.equal(parseCooldown('4:15'), 255);
  assert.equal(parseCooldown('35'), 35);
  for (const value of ['4:75', '0', '999', 'F', '4/15']) assert.equal(parseCooldown(value), null);
});

test('flash gets V4, merges with KDA events, and never duplicates the opening', () => {
  const source = { in: 0, out: 500, fpsNum: 60, fpsDen: 1, openingWindow: { in: 50, out: 210 } };
  const events = [
    { id: 'f0', type: 'flash', time: 100 },
    { id: 'f1', type: 'flash', time: 240 },
    { id: 'f2', type: 'flash', time: 300 },
    { id: 'k1', type: 'kill', time: 303 },
  ];
  const plan = planClips(events, source);
  assert.deepEqual(
    plan.clips.map((c) => c.type),
    ['opening', 'flash', 'kill'],
  );
  assert.equal(plan.clips[1].track, 3);
  assert.deepEqual(plan.clips[2].eventIds, ['f2', 'k1']);
  assert.deepEqual(
    planClips(events, source, { types: ['flash'] }).clips.map((c) => c.track),
    [0, 3, 3],
  );
  assert.deepEqual(
    planClips(events, source, { types: ['kill'] }).clips.map((c) => c.type),
    ['opening', 'kill'],
  );
});

test('real F-slot crops recognize ready/cooldown and reject death, occlusion and the other spell', async () => {
  const pool = await ocrPool();
  try {
    const samples = [];
    for (const [name, time, state, cooldown] of [
      ['ready', 290, 'ready', null],
      ['ready', 290.5, 'ready', null],
      ['used', 291, 'cooldown', 254],
      ['used-half', 291.5, 'cooldown', 254],
      ['countdown', 292, 'cooldown', 253],
      ['dead', 1530, 'unknown', null],
      ['occluded', 690, 'unknown', null],
      ['other-spell', 120, 'unknown', null],
    ]) {
      const value = await readFlash(
        pool,
        await readFile(new URL(`./fixtures/flash/${name}.png`, import.meta.url)),
      );
      assert.equal(value.state, state, name);
      assert.equal(value.cooldown, cooldown, name);
      if (time <= 292 && time >= 290) samples.push({ time, ...value });
    }
    assert.equal(detectFlashEvents(samples)[0].time, 291);
  } finally {
    await pool.terminate();
  }
});
