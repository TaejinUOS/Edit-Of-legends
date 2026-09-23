import test from 'node:test';
import assert from 'node:assert/strict';
import { createClockSampler } from '../engine/clock-sampling.js';

const clockRoi = { kind: 'clock' };
const hudRoi = { kind: 'hud' };
function setup(source, interval = 0.5, value = (time) => time, signal) {
  const calls = [],
    reads = [];
  async function* sample(range, regions, step) {
    calls.push({ in: range.in, out: range.out, step, regions });
    for (let i = 0; range.in + i * step < range.out - 1e-7; i++) {
      const time = range.in + i * step;
      const frame = { time, raw: Buffer.alloc(1) };
      yield Array.isArray(regions) ? { time, regions: regions.map(() => frame) } : frame;
    }
  }
  const sampler = createClockSampler(
    source,
    clockRoi,
    interval,
    async (_, frame) => {
      reads.push(frame.time);
      return { clockSeconds: value(frame.time), confidence: 99, text: '' };
    },
    signal,
    4,
    () => {},
    sample,
  );
  const collect = async () => {
    const frames = [];
    for await (const frame of sampler.frames([hudRoi])) frames.push(frame);
    return frames;
  };
  return { sampler, calls, reads, collect };
}

test('clock shares the main decode and stops OCR after stable observations', async () => {
  const x = setup({ in: 0, out: 90, duration: 120 });
  const frames = await x.collect();
  assert.equal(x.calls.length, 1);
  assert.deepEqual(x.calls[0].regions, [hudRoi, clockRoi]);
  assert.equal(frames.length, 180);
  assert.ok(frames.every((f) => f.regions.length === 1));
  assert.deepEqual(
    x.reads,
    Array.from({ length: 11 }, (_, i) => i * 2),
  );
  assert.deepEqual(x.sampler.openingWindow, { in: 50, out: 90, offset: 0, samples: 11 });
});

test('selection look-behind uses only the clock and preserves source timestamps', async () => {
  const x = setup({ in: 170, out: 210, duration: 300 }, 0.5, (t) => t - 35);
  const frames = await x.collect();
  assert.equal(x.calls.length, 2);
  assert.equal(x.calls[0].in, 140);
  assert.equal(x.calls[0].out, 170);
  assert.deepEqual(x.calls[1].regions, [hudRoi]);
  assert.equal(frames[0].time, 170);
  assert.deepEqual(x.sampler.openingWindow, { in: 170, out: 210, offset: 35, samples: 11 });
});

test('short clip reads clock beyond its end without adding analysis frames', async () => {
  const x = setup({ in: 0, out: 60, duration: 120 }, 0.5, (t) => (t < 48 ? null : t));
  const frames = await x.collect();
  assert.equal(frames.length, 120);
  assert.equal(x.calls.length, 2);
  assert.equal(x.calls[1].in, 60);
  assert.equal(x.reads.at(-1), 68);
  assert.deepEqual(x.sampler.openingWindow, { in: 50, out: 60, offset: 0, samples: 11 });
});

test('fractional start preserves the original clock grid; incompatible grids use the old pass', async () => {
  const aligned = setup({ in: 1.5, out: 90, duration: 120 });
  await aligned.collect();
  assert.deepEqual(
    aligned.reads,
    Array.from({ length: 11 }, (_, i) => i * 2),
  );
  for (const [start, interval] of [
    [0, 0.7],
    [0.1, 0.5],
  ]) {
    const x = setup({ in: start, out: 90, duration: 120 }, interval);
    const frames = await x.collect();
    assert.equal(x.calls.length, 2);
    assert.deepEqual(x.calls[1].regions, [hudRoi]);
    assert.equal(frames[0].time, start);
  }
});

test('unreadable clock stops at the search limit and cancellation propagates', async () => {
  const missing = setup({ in: 0, out: 1000, duration: 1000 }, 0.5, () => null);
  await assert.rejects(missing.collect(), /시간 HUD/);
  assert.equal(missing.reads.at(-1), 898);
  const controller = new AbortController();
  const cancelled = setup({ in: 0, out: 90, duration: 120 }, 0.5, (t) => t, controller.signal);
  const iterator = cancelled.sampler.frames([hudRoi]);
  await iterator.next();
  controller.abort();
  await assert.rejects(iterator.next(), { name: 'AbortError' });
});
