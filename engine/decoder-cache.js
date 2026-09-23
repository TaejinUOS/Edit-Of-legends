import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, unlink, stat } from 'node:fs/promises';
import { bin } from './media.js';
import { roiPixels } from './core.js';

const MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
// Bump when tuning, decoding, or OCR implementation changes affect throughput.
const PROFILE_REVISION = 1;

export function decoderProfileKey(source, { available, workers, interval, roi, flash }, runtime) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        revision: PROFILE_REVISION,
        runtime,
        available,
        workers,
        interval,
        video: [
          source.width,
          source.height,
          source.fpsNum,
          source.fpsDen,
          source.pixelFormat ?? null,
          source.colorRange ?? null,
        ],
        roi: roiPixels(roi, source.width, source.height),
        flash: flash.enabled ? roiPixels(flash.roi, source.width, source.height) : null,
      }),
    )
    .digest('hex');
}

export async function decoderProfileLocation(source, options, stateDir) {
  try {
    const executable = bin('ffmpeg');
    const info = await stat(executable);
    const cpus = os.cpus();
    const runtime = {
      platform: process.platform,
      arch: process.arch,
      release: os.release(),
      cpu: [...new Set(cpus.map((cpu) => cpu.model))].sort(),
      cpuCount: cpus.length,
      node: process.versions.node,
      v8: process.versions.v8,
      ffmpeg: [executable, info.size, info.mtimeMs],
    };
    const directory = path.join(
      stateDir ?? process.env.EOL_DATA_DIR ?? fileURLToPath(new URL('../.eol', import.meta.url)),
      'decoder-profiles',
    );
    return { directory, key: decoderProfileKey(source, options, runtime) };
  } catch {
    // Performance metadata must never prevent analysis.
    return null;
  }
}

export async function readDecoderProfile(location, candidates, now = Date.now()) {
  if (!location) return null;
  try {
    const value = JSON.parse(
      await readFile(path.join(location.directory, `${location.key}.json`), 'utf8'),
    );
    if (
      value.key !== location.key ||
      !candidates.includes(value.threads) ||
      !Number.isFinite(value.createdAt) ||
      value.createdAt > now ||
      now - value.createdAt > MAX_AGE_MS
    )
      return null;
    return value.threads;
  } catch {
    return null;
  }
}

export async function writeDecoderProfile(location, threads, now = Date.now()) {
  if (!location || !Number.isInteger(threads) || threads < 1 || threads > 8) return false;
  const file = path.join(location.directory, `${location.key}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await mkdir(location.directory, { recursive: true });
    await writeFile(temporary, JSON.stringify({ key: location.key, threads, createdAt: now }));
    await rename(temporary, file);
    return true;
  } catch {
    await unlink(temporary).catch(() => {});
    return false;
  }
}
