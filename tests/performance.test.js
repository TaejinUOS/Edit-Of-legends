import test from 'node:test';
import assert from 'node:assert/strict';
import { threadCandidates, fastestThreads, memoizeOcr } from '../engine/performance.js';
import { readKda } from '../engine/analyzer.js';

test('decoder candidates reserve capacity for simultaneous OCR', () => {
  assert.deepEqual(threadCandidates(16, 4), [4, 5, 6, 7, 8]);
  assert.deepEqual(threadCandidates(12, 4), [4, 5, 6]);
  assert.deepEqual(threadCandidates(8, 4), [2]);
  assert.deepEqual(threadCandidates(1, 1), [1]);
  assert.equal(
    fastestThreads([
      { threads: 4, elapsedMs: 102 },
      { threads: 8, elapsedMs: 100 },
      { threads: 8, elapsedMs: 100 },
      { threads: 4, elapsedMs: 102 },
    ]),
    4,
  );
  assert.equal(
    fastestThreads([
      { threads: 4, elapsedMs: 120 },
      { threads: 8, elapsedMs: 100 },
    ]),
    8,
  );
});

test('HUD results share concurrent recognition and distinguish dimensions and changed pixels', async () => {
  let calls = 0;
  const pool = {
    addJob: async () => {
      calls++;
      return { data: { text: '1/2/3', confidence: 95 } };
    },
  };
  const raw = Buffer.alloc(200, 100);
  const info = { width: 20, height: 10 };
  const results = await Promise.all(Array.from({ length: 8 }, () => readKda(pool, raw, info)));
  assert.equal(calls, 1);
  assert.deepEqual(results[0].kda, [1, 2, 3]);
  await readKda(pool, Buffer.from(raw), info);
  assert.equal(calls, 1);
  await readKda(pool, raw, { width: 10, height: 20 });
  raw[0]++;
  await readKda(pool, raw, info);
  assert.equal(calls, 3);
});

test('OCR cache retries errors and evicts least recently used entries', async () => {
  const cache = new Map();
  await assert.rejects(
    memoizeOcr(cache, 'error', () => {
      throw Error('retry');
    }),
  );
  assert.equal(await memoizeOcr(cache, 'error', () => 1), 1);
  await memoizeOcr(cache, 'next', () => 2, 2);
  await memoizeOcr(cache, 'error', () => 3, 2);
  await memoizeOcr(cache, 'last', () => 4, 2);
  assert.deepEqual([...cache.keys()], ['error', 'last']);
});
