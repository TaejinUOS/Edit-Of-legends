import { createRequire } from 'node:module';
import os from 'node:os';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createWorker, createScheduler, PSM } from 'tesseract.js';
import {
  parseKda,
  parseGameClock,
  detectEvents,
  detectOpeningWindow,
  number,
  roiPixels,
  DEFAULT_CLOCK_ROI,
} from './core.js';
import { sampleFrames, verifyCfr } from './media.js';
import { glyphImages } from './ocr-image.js';
import { threadCandidates, fastestThreads, memoizeOcr } from './performance.js';

const require = createRequire(import.meta.url);
const language = require('@tesseract.js-data/eng');
const glyphCaches = new WeakMap();
const hudCaches = new WeakMap();

function resetCaches(pool) {
  glyphCaches.set(pool, new Map());
  hudCaches.set(pool, new Map());
}

export async function ocrPool(count = 1) {
  const scheduler = createScheduler();
  try {
    for (let i = 0; i < count; i++) {
      const w = await createWorker('eng', 1, {
        langPath: language.langPath,
        gzip: true,
        cacheMethod: 'none',
      });
      scheduler.addWorker(w);
      // Numeric PSM is intentional: string '10' in this WASM build drops isolated zeroes.
      await w.setParameters({
        tessedit_pageseg_mode: Number(PSM.SINGLE_CHAR),
        tessedit_char_whitelist: '0123456789/:',
        user_defined_dpi: '70',
      });
    }
    resetCaches(scheduler);
    return scheduler;
  } catch (e) {
    await scheduler.terminate();
    throw e;
  }
}

export async function readKda(pool, input, rawInfo) {
  if (!hudCaches.has(pool)) resetCaches(pool);
  const key = createHash('sha256')
    .update(rawInfo ? `raw:${rawInfo.width}:${rawInfo.height}:` : 'encoded:')
    .update(input)
    .digest('hex');
  return memoizeOcr(hudCaches.get(pool), key, () => recognizeKda(pool, input, rawInfo));
}

export async function readGameClock(pool, input, rawInfo) {
  if (!hudCaches.has(pool)) resetCaches(pool);
  const key = createHash('sha256')
    .update(rawInfo ? `clock:raw:${rawInfo.width}:${rawInfo.height}:` : 'clock:encoded:')
    .update(input)
    .digest('hex');
  return memoizeOcr(hudCaches.get(pool), key, () => recognizeGameClock(pool, input, rawInfo));
}

async function recognizeGameClock(pool, input, rawInfo) {
  const image = sharp(
    input,
    rawInfo ? { raw: { width: rawInfo.width, height: rawInfo.height, channels: 1 } } : undefined,
  );
  const width = rawInfo?.width ?? (await image.metadata()).width;
  const base = image
    .resize(width * 4)
    .grayscale()
    .normalize();
  for (const candidate of [base.clone().negate(), base]) {
    const png = await candidate.png().toBuffer();
    const row = (
      await pool.addJob('recognize', png, { tessedit_pageseg_mode: Number(PSM.SINGLE_LINE) })
    ).data;
    const clockSeconds = parseGameClock(row.text);
    if (clockSeconds !== null && row.confidence >= 35)
      return { text: row.text.trim(), clockSeconds, confidence: row.confidence };
  }
  return { text: '', clockSeconds: null, confidence: 0 };
}

async function recognizeKda(pool, input, rawInfo) {
  const lineImage = sharp(
    input,
    rawInfo ? { raw: { width: rawInfo.width, height: rawInfo.height, channels: 1 } } : undefined,
  );
  const width = rawInfo?.width ?? (await lineImage.metadata()).width;
  const png = await lineImage
    .resize(width * 4)
    .grayscale()
    .negate()
    .normalize()
    .png()
    .toBuffer();
  const row = (
    await pool.addJob('recognize', png, { tessedit_pageseg_mode: Number(PSM.SINGLE_LINE) })
  ).data;
  const rowKda = parseKda(row.text);
  if (rowKda && row.confidence >= 80)
    return { text: row.text.trim(), kda: rowKda, confidence: row.confidence };
  const images = await glyphImages(input, rawInfo);
  if (!images) return { text: '', kda: null, confidence: 0 };
  const cache = glyphCaches.get(pool);
  const chars = await Promise.all(
    images.map((png) => {
      const key = createHash('sha256').update(png).digest('hex');
      return memoizeOcr(cache, key, () => pool.addJob('recognize', png).then((r) => r.data));
    }),
  );
  const text = chars.map((c) => c.text.trim()).join('');
  const valid = chars.every((c) => /^[0-9/]$/.test(c.text.trim()));
  return {
    text,
    kda: valid ? parseKda(text) : null,
    confidence: Math.round(chars.reduce((n, c) => n + c.confidence, 0) / chars.length),
  };
}

export async function analyze(source, options, signal, onProgress = () => {}) {
  const interval = number(options.interval ?? 0.5, '분석 간격', 0.25, 2);
  roiPixels(options.roi, source.width, source.height);
  const clockRoi = options.clockRoi ?? DEFAULT_CLOCK_ROI;
  roiPixels(clockRoi, source.width, source.height);
  const available = os.availableParallelism();
  const workers =
    options.workers === 'auto' || !options.workers
      ? Math.max(1, Math.min(4, Math.floor(available / 2)))
      : Math.min(available, Math.floor(number(options.workers, '분석 워커', 1, 8)));
  onProgress({ stage: '미디어 검사', progress: 0, workers });
  await verifyCfr(source, signal);
  onProgress({ stage: 'OCR 준비', progress: 0, workers });
  const pool = await ocrPool(workers);
  const candidates = threadCandidates(available, workers);
  const threadTrials = [];
  let decoderThreads = candidates[0];
  const samples = [],
    batch = [];
  try {
    if (candidates.length > 1) {
      const preview = { ...source, out: Math.min(source.out, source.in + 8) };
      // Warm up WASM before timing; each trial starts with equally empty caches.
      for await (const f of sampleFrames(
        { ...preview, out: Math.min(preview.out, preview.in + interval) },
        options.roi,
        interval,
        signal,
        decoderThreads,
      ))
        await readKda(pool, f.raw, f);
      for (const threads of [...candidates, ...candidates.toReversed()]) {
        signal?.throwIfAborted();
        resetCaches(pool);
        onProgress({
          stage: `디코딩·OCR 비교 (${threads}스레드)`,
          progress: 0,
          workers,
          decoderThreads: threads,
        });
        const started = performance.now();
        const pending = [];
        let frames = 0;
        try {
          for await (const f of sampleFrames(preview, options.roi, interval, signal, threads)) {
            // Attach rejection handlers immediately while decoding continues.
            pending.push(
              readKda(pool, f.raw, f).then(
                () => null,
                (error) => error,
              ),
            );
            frames++;
            if (pending.length >= workers * 2) {
              const errors = await Promise.all(pending);
              pending.length = 0;
              const error = errors.find(Boolean);
              if (error) throw error;
            }
          }
          const errors = await Promise.all(pending);
          const error = errors.find(Boolean);
          if (error) throw error;
        } finally {
          await Promise.allSettled(pending);
        }
        threadTrials.push({ threads, elapsedMs: performance.now() - started, frames });
      }
      decoderThreads = fastestThreads(threadTrials);
      resetCaches(pool);
    }
    const clockSamples = [];
    onProgress({ stage: '인게임 시간 분석', progress: 0, workers, decoderThreads });
    const clockSource = {
      ...source,
      in: Math.max(0, source.in - 30),
      out: Math.min(source.duration ?? source.out, source.in + 900),
    };
    for await (const f of sampleFrames(clockSource, clockRoi, 2, signal, decoderThreads)) {
      const value = await readGameClock(pool, f.raw, f);
      clockSamples.push({ time: f.time, ...value });
      if (clockSamples.length % 10 === 0)
        onProgress({
          stage: '인게임 시간 분석',
          progress: Math.min(
            0.1,
            (0.1 * (f.time - clockSource.in)) / (clockSource.out - clockSource.in),
          ),
          workers,
          decoderThreads,
        });
      if (value.clockSeconds >= 220) {
        try {
          detectOpeningWindow(clockSamples, source);
          break;
        } catch (error) {
          if (error.message.includes('선택한 원본 구간')) throw error;
          // Keep sampling until enough consistent clock readings are available.
        }
      }
    }
    const openingWindow = detectOpeningWindow(clockSamples, source);
    const flush = async () => {
      const completed = await Promise.allSettled(batch.splice(0));
      const failed = completed.find((entry) => entry.status === 'rejected');
      if (failed) throw failed.reason;
      const values = completed.map((entry) => entry.value);
      samples.push(...values);
      const t = samples.at(-1)?.time ?? source.in;
      onProgress({
        stage: 'K/D/A 분석',
        progress: Math.min(0.99, 0.1 + (0.89 * (t - source.in)) / (source.out - source.in)),
        samples: samples.length,
        workers,
        decoderThreads,
      });
    };
    for await (const f of sampleFrames(source, options.roi, interval, signal, decoderThreads)) {
      const pending = readKda(pool, f.raw, f).then((value) => ({ time: f.time, ...value }));
      pending.catch(() => {});
      batch.push(pending);
      if (batch.length >= workers * 2) await flush();
    }
    if (batch.length) await flush();
    if (signal?.aborted) throw new Error('분석을 취소했습니다.');
    const result = detectEvents(samples, interval);
    if (!result.finalKda)
      throw new Error(
        'K/D/A를 읽지 못했습니다. 숫자 세 개와 / 구분자만 포함하도록 HUD 영역을 조정하세요.',
      );
    return {
      ...result,
      openingWindow,
      clockSamples,
      samples,
      workers,
      interval,
      decoderThreads,
      threadTrials,
    };
  } finally {
    await Promise.allSettled(batch);
    await pool.terminate();
  }
}
