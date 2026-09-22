import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  detectEvents,
  parseKda,
  planClips,
  trimPlan,
  roiPixels,
  cacheKey,
  DEFAULT_ROI,
  ANALYSIS_REVISION,
  parseGameClock,
  detectOpeningWindow,
} from '../engine/core.js';
const source = {
  in: 0,
  out: 200,
  duration: 200,
  fpsNum: 60,
  fpsDen: 1,
  openingWindow: { in: 0, out: 180 },
};
const e = (type, time, id = type + time) => ({ type, time, id, amount: 1, included: true });
const sample = (time, kda, confidence = 90) => ({ time, kda, confidence });
test('KDA parser rejects concatenated numbers and unrelated text', () => {
  assert.deepEqual(parseKda(' 7 / 2 / 7\n'), [7, 2, 7]);
  for (const s of ['7127', '7/2/7 extra', '7/2', '7/2/777']) assert.equal(parseKda(s), null);
});
test('game clock parser accepts only a valid mm:ss display', () => {
  assert.equal(parseGameClock(' 0:50 '), 50);
  assert.equal(parseGameClock('03:30'), 210);
  for (const value of ['3:60', '2:5', 'K/D/A', '99:00']) assert.equal(parseGameClock(value), null);
});
test('stable HUD clock readings locate 0:50 through 3:30 in source time', () => {
  const samples = Array.from({ length: 100 }, (_, i) => ({
    time: 40 + i * 2,
    clockSeconds: 20 + i * 2,
    confidence: 90,
  }));
  samples[5].clockSeconds = 200;
  const opening = detectOpeningWindow(samples, { in: 0, out: 300 });
  assert.equal(opening.in, 70);
  assert.equal(opening.out, 230);
  assert.equal(opening.samples, 99);
  assert.throws(() => detectOpeningWindow(samples.slice(0, 3), { in: 0, out: 300 }), /안정적으로/);
  assert.throws(() => detectOpeningWindow(samples, { in: 250, out: 300 }), /선택한 원본 구간/);
});
test('nonzero initial KDA is a baseline, not events', () => {
  assert.equal(detectEvents([sample(0, [4, 2, 8]), sample(0.5, [4, 2, 8])]).events.length, 0);
});
test('two observations retain first increase timestamp', () => {
  const r = detectEvents([
    sample(0, [0, 0, 0]),
    sample(0.5, [0, 0, 0]),
    sample(1, [1, 0, 0]),
    sample(1.5, [1, 0, 0]),
  ]);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].time, 1);
  assert.equal(r.events[0].type, 'kill');
});
test('isolated OCR spikes do not create events', () => {
  const r = detectEvents([
    sample(0, [0, 0, 0]),
    sample(0.5, [0, 0, 0]),
    sample(1, [8, 0, 0]),
    sample(1.5, [0, 0, 0]),
    sample(2, [0, 0, 0]),
  ]);
  assert.equal(r.events.length, 0);
});
test('occlusion produces an excluded review candidate with uncertainty bounds', () => {
  const r = detectEvents([
    sample(0, [0, 0, 0]),
    sample(0.5, [0, 0, 0]),
    sample(1, null),
    sample(3, [1, 0, 0]),
    sample(3.5, [1, 0, 0]),
  ]);
  assert.deepEqual(r.events[0].range, [0.5, 3]);
  assert.equal(r.events[0].included, false);
});

test('sustained transient OCR jumps cannot poison the baseline', () => {
  const r = detectEvents([
    sample(0, [0, 0, 0]),
    sample(0.5, [0, 0, 0]),
    ...Array.from({ length: 8 }, (_, i) => sample(1 + i * 0.5, [8, 0, 0])),
    sample(5, [0, 0, 0]),
    sample(5.5, [0, 0, 0]),
    sample(6, [0, 0, 1]),
    sample(6.5, [0, 0, 1]),
  ]);
  assert.equal(r.stopped, false);
  assert.deepEqual(r.finalKda, [0, 0, 1]);
  assert.equal(r.events.length, 1);
  assert.equal(r.events[0].time, 6);
});

test('short downward OCR errors recover without stopping analysis', () => {
  const r = detectEvents([
    sample(0, [7, 2, 7]),
    sample(0.5, [7, 2, 7]),
    ...Array.from({ length: 4 }, (_, i) => sample(1 + i * 0.5, [1, 2, 7])),
    sample(3, [7, 2, 7]),
    sample(3.5, [7, 2, 7]),
  ]);
  assert.equal(r.stopped, false);
  assert.deepEqual(r.finalKda, [7, 2, 7]);
  assert.equal(r.events.length, 0);
});
test('multi-increase retains amount and requires review', () => {
  const r = detectEvents([
    sample(0, [0, 0, 0]),
    sample(0.5, [0, 0, 0]),
    sample(1, [2, 0, 1]),
    sample(1.5, [2, 0, 1]),
  ]);
  assert.equal(r.events[0].amount, 2);
  assert.equal(r.events[0].review, true);
  assert.equal(r.events[1].type, 'assist');
});
test('sustained reset stops automatic confirmation', () => {
  const s = [
    sample(0, [5, 1, 3]),
    sample(0.5, [5, 1, 3]),
    ...Array.from({ length: 4 }, (_, i) => sample(1 + i * 0.5, [0, 0, 0])),
  ];
  const r = detectEvents(s);
  assert.equal(r.stopped, true);
  assert.equal(r.events.length, 0);
  assert.equal(r.warnings.length, 1);
});
test('unreadable and readable no-event videos are distinct', () => {
  assert.equal(detectEvents([sample(0, null)]).finalKda, null);
  assert.deepEqual(
    detectEvents([sample(0, [0, 0, 0]), sample(0.5, [0, 0, 0])]).finalKda,
    [0, 0, 0],
  );
});
test('the opening window is always the first clip, even with every event type disabled', () => {
  const timed = { ...source, out: 400, openingWindow: { in: 50, out: 210 } };
  const p = planClips([e('kill', 230)], timed, { types: [] });
  assert.equal(p.clips.length, 1);
  assert.deepEqual(
    [p.clips[0].type, p.clips[0].track, p.clips[0].in, p.clips[0].out],
    ['opening', 0, 50, 210],
  );
  assert.deepEqual(p.clips[0].eventIds, []);
  assert.equal(p.clips[0].long, false);
  assert.equal(p.frames, 9600);
  assert.equal(planClips([], timed).clips.length, 1);
});
test('opening clip uses in-game 0:50–3:30 rather than the recording start', () => {
  const timed = { ...source, out: 400, openingWindow: { in: 70, out: 230 } };
  const p = planClips([e('kill', 65), e('assist', 120), e('death', 230)], timed);
  assert.deepEqual(
    p.clips.map((c) => [c.type, c.in, c.out]),
    [
      ['opening', 70, 230],
      ['death', 230, 237],
    ],
  );
});
test('events inside the opening do not duplicate it; boundary events follow it', () => {
  const p = planClips([e('kill', 30), e('death', 179), e('assist', 180), e('kill', 230)], {
    ...source,
    out: 400,
  });
  assert.deepEqual(
    p.clips.map((c) => [c.type, c.in, c.out]),
    [
      ['opening', 0, 180],
      ['assist', 180, 187],
      ['kill', 219, 237],
    ],
  );
  assert.deepEqual(p.clips[1].eventIds, ['assist180']);
});
test('the opening respects trimmed and short source bounds', () => {
  const trimmed = planClips([], {
    ...source,
    in: 30,
    out: 250,
    openingWindow: { in: 30, out: 210 },
  });
  assert.deepEqual([trimmed.clips[0].in, trimmed.clips[0].out], [30, 210]);
  const short = planClips([], { ...source, in: 30, out: 90, openingWindow: { in: 30, out: 90 } });
  assert.deepEqual([short.clips[0].in, short.clips[0].out], [30, 90]);
  assert.equal(short.clips.length, 1);
});
test('PRD chained event example produces one 30 second kill clip', () => {
  const p = planClips([e('kill', 280), e('assist', 288), e('death', 292)], { ...source, out: 400 });
  assert.equal(p.clips.length, 2);
  assert.equal(p.clips[1].in, 269);
  assert.equal(p.clips[1].out, 299);
  assert.equal(p.duration, 210);
  assert.equal(p.clips[1].track, 0);
  assert.equal(p.clips[1].eventIds.length, 3);
});
test('type filters apply BEFORE grouping and precedence', () => {
  const p = planClips(
    [e('kill', 280), e('assist', 288), e('death', 292)],
    { ...source, out: 400 },
    {
      types: ['death'],
    },
  );
  assert.equal(p.clips[1].in, 281);
  assert.equal(p.clips[1].track, 2);
  assert.deepEqual(p.clips[1].eventIds, ['death292']);
});
test('overlapping handles merge even when simultaneous window is zero', () => {
  const p = planClips([e('death', 230), e('kill', 240)], { ...source, out: 400 }, { gap: 0 });
  assert.equal(p.clips.length, 2);
  assert.equal(p.clips[1].track, 0);
});
test('all tracks share the contiguous output clock', () => {
  const p = planClips([e('death', 230), e('assist', 290), e('kill', 350)], { ...source, out: 400 });
  assert.deepEqual(
    p.clips.map((c) => c.track),
    [0, 2, 1, 0],
  );
  assert.deepEqual(
    p.clips.map((c) => c.outputInFrame),
    [0, 10800, 11880, 12960],
  );
  assert.equal(p.frames, 14040);
});
test('trimmed source limits handles and frames', () => {
  const p = planClips([e('kill', 20), e('death', 90)], {
    ...source,
    in: 20,
    out: 90,
    openingWindow: { in: 20, out: 90 },
  });
  assert.equal(p.clips[0].in, 20);
  assert.equal(p.clips.at(-1).out, 90);
  assert.ok(p.clips.every((c) => Number.isInteger(c.inFrame) && Number.isInteger(c.outFrame)));
});
test('invalid settings and out of source events fail closed', () => {
  for (const settings of [
    { before: 0, after: 0 },
    { before: -1 },
    { gap: Infinity },
    { types: ['other'] },
  ])
    assert.throws(() => planClips([], source, settings));
  assert.throws(() => planClips([e('kill', 201)], source));
  assert.throws(() => planClips([e('other', 20)], source));
});
test('ROI validation prevents crops outside video', () => {
  assert.deepEqual(roiPixels(DEFAULT_ROI, 2560, 1440), { x: 2219, y: 1, width: 99, height: 31 });
  assert.throws(() => roiPixels({ x: 0.99, y: 0, width: 0.1, height: 0.1 }, 1920, 1080));
});
test('analysis cache changes with source or ROI, not clip planning', () => {
  const s = { ...source, path: 'x', size: 1, modified: 1 };
  const a = cacheKey(s, DEFAULT_ROI, 0.5);
  assert.notEqual(a, cacheKey({ ...s, modified: 2 }, DEFAULT_ROI, 0.5));
  assert.notEqual(a, cacheKey(s, { ...DEFAULT_ROI, x: 0.8 }, 0.5));
  assert.notEqual(a, cacheKey(s, DEFAULT_ROI, 1));
  assert.notEqual(a, cacheKey(s, DEFAULT_ROI, 0.5, { x: 0.9, y: 0, width: 0.05, height: 0.03 }));
  assert.notEqual(a, cacheKey({ ...s, out: 100 }, DEFAULT_ROI, 0.5));
  assert.equal(a, cacheKey({ ...s, before: 99 }, DEFAULT_ROI, 0.5));
});

test('app releases preserve cache keys; analysis revisions invalidate them', async () => {
  const code = await readFile(new URL('../engine/core.js', import.meta.url), 'utf8');
  const load = (text) =>
    import(`data:text/javascript;base64,${Buffer.from(text).toString('base64')}`);
  const released = await load(
    code.replace(/export const VERSION = '[^']+';/, "export const VERSION = '999.0.0';"),
  );
  const revised = await load(
    code.replace(
      `export const ANALYSIS_REVISION = ${ANALYSIS_REVISION};`,
      `export const ANALYSIS_REVISION = ${ANALYSIS_REVISION + 1};`,
    ),
  );
  const s = { ...source, path: 'x', size: 1, modified: 1 };
  assert.equal(released.VERSION, '999.0.0');
  assert.equal(revised.ANALYSIS_REVISION, ANALYSIS_REVISION + 1);
  assert.equal(cacheKey(s, DEFAULT_ROI, 0.5), released.cacheKey(s, DEFAULT_ROI, 0.5));
  assert.notEqual(cacheKey(s, DEFAULT_ROI, 0.5), revised.cacheKey(s, DEFAULT_ROI, 0.5));
});
test('manual clip trim recalculates downstream output positions and rejects overlaps', () => {
  const extended = { ...source, out: 400 };
  const p = planClips([e('kill', 230), e('death', 280)], extended);
  const r = trimPlan(p, { kill230: { in: 220, out: 240 } }, extended);
  assert.equal(r.clips[2].outputInFrame, 12000);
  assert.equal(r.duration, 218);
  assert.throws(() => trimPlan(p, { kill230: { in: 220, out: 280 } }, extended), /겹칠/);
  assert.throws(() => trimPlan(p, { kill230: { in: 240, out: 220 } }, extended), /0보다/);
  assert.throws(() => trimPlan(p, { opening: { in: 0, out: 60 } }, extended), /0:50–3:30/);
});
