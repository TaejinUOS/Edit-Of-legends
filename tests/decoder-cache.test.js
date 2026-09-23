import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import {
  decoderProfileKey,
  readDecoderProfile,
  writeDecoderProfile,
} from '../engine/decoder-cache.js';

const source = {
  width: 1920,
  height: 1080,
  fpsNum: 60,
  fpsDen: 1,
  pixelFormat: 'yuv420p',
  colorRange: 'tv',
};
const options = {
  available: 16,
  workers: 4,
  interval: 0.5,
  roi: { x: 0.8, y: 0, width: 0.04, height: 0.02 },
  flash: { enabled: true, roi: { x: 0.5, y: 0.9, width: 0.02, height: 0.03 } },
};
const runtime = { cpu: 'CPU A', ffmpeg: ['ffmpeg.exe', 100, 200], node: '24' };

test('decoder profiles share videos but distinguish hardware, runtime and analysis conditions', () => {
  const key = decoderProfileKey(source, options, runtime);
  assert.equal(
    key,
    decoderProfileKey({ ...source, path: 'other.mp4', in: 300, out: 600 }, options, runtime),
  );
  for (const change of [
    { width: 2560, height: 1440 },
    { fpsNum: 30 },
    { pixelFormat: 'yuv444p' },
    { colorRange: 'pc' },
  ])
    assert.notEqual(key, decoderProfileKey({ ...source, ...change }, options, runtime));
  for (const change of [
    { available: 12 },
    { workers: 8 },
    { interval: 1 },
    { flash: { enabled: false } },
    { roi: { ...options.roi, width: 0.05 } },
  ])
    assert.notEqual(key, decoderProfileKey(source, { ...options, ...change }, runtime));
  for (const change of [{ cpu: 'CPU B' }, { ffmpeg: ['ffmpeg.exe', 100, 201] }, { node: '25' }])
    assert.notEqual(key, decoderProfileKey(source, options, { ...runtime, ...change }));
});

test('decoder choice persists, rejects stale/corrupt/ineligible data, and survives storage failure', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'eol-decoder-'));
  try {
    const key = decoderProfileKey(source, options, runtime);
    const location = { directory, key };
    const file = path.join(directory, `${key}.json`);
    const now = 1700000000000;
    assert.equal(await readDecoderProfile(location, [4, 5, 6], now), null);
    assert.equal(await writeDecoderProfile(location, 5, now), true);
    // Read the file again with a fresh location object: no in-memory cache.
    assert.equal(await readDecoderProfile({ directory, key }, [4, 5, 6], now + 1000), 5);
    assert.equal(await readDecoderProfile(location, [4], now + 1000), null);
    assert.equal(await readDecoderProfile(location, [5], now + 31 * 86400000), null);
    assert.equal(await readDecoderProfile(location, [5], now - 1), null);
    const stored = JSON.parse(await readFile(file, 'utf8'));
    await writeFile(file, JSON.stringify({ ...stored, key: 'wrong' }));
    assert.equal(await readDecoderProfile(location, [5], now), null);
    await writeFile(file, '{interrupted');
    assert.equal(await readDecoderProfile(location, [5], now), null);
    assert.equal(await writeDecoderProfile(location, 6, now), true);
    assert.equal(await readDecoderProfile(location, [6], now), 6);
    assert.equal(await writeDecoderProfile({ directory: file, key }, 5, now), false);
    assert.equal(await readDecoderProfile(null, [4], now), null);
    assert.equal(await writeDecoderProfile(null, 4, now), false);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
