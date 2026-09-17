import { createRequire } from 'node:module';
import os from 'node:os';
import sharp from 'sharp';
import { createHash } from 'node:crypto';
import { createWorker, createScheduler, PSM } from 'tesseract.js';
import { parseKda, detectEvents, number, roiPixels } from './core.js';
import { sampleFrames, verifyCfr } from './media.js';
import { glyphImages } from './ocr-image.js';

const require = createRequire(import.meta.url);
const language = require('@tesseract.js-data/eng');
const glyphCaches = new WeakMap();

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
        tessedit_char_whitelist: '0123456789/',
        user_defined_dpi: '70',
      });
    }
    glyphCaches.set(scheduler, new Map());
    return scheduler;
  } catch (e) {
    await scheduler.terminate();
    throw e;
  }
}

export async function readKda(pool, input, rawInfo) {
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
      if (!cache.has(key)) {
        if (cache.size >= 2048) cache.delete(cache.keys().next().value);
        cache.set(
          key,
          pool.addJob('recognize', png).then((r) => r.data),
        );
      }
      return cache.get(key);
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
  const available = os.availableParallelism();
  const workers =
    options.workers === 'auto' || !options.workers
      ? Math.max(1, Math.min(4, Math.floor(available / 2)))
      : Math.min(available, Math.floor(number(options.workers, '분석 워커', 1, 8)));
  onProgress({ stage: '미디어 검사', progress: 0, workers });
  await verifyCfr(source, signal);
  onProgress({ stage: 'OCR 준비', progress: 0, workers });
  const pool = await ocrPool(workers);
  const samples = [],
    batch = [];
  try {
    const flush = async () => {
      const values = await Promise.all(batch.splice(0));
      samples.push(...values);
      const t = samples.at(-1)?.time ?? source.in;
      onProgress({
        stage: 'K/D/A 분석',
        progress: Math.min(0.99, (t - source.in) / (source.out - source.in)),
        samples: samples.length,
        workers,
      });
    };
    for await (const f of sampleFrames(source, options.roi, interval, signal)) {
      batch.push(readKda(pool, f.raw, f).then((value) => ({ time: f.time, ...value })));
      if (batch.length >= workers * 2) await flush();
    }
    if (batch.length) await flush();
    if (signal.aborted) throw new Error('분석을 취소했습니다.');
    const result = detectEvents(samples, interval);
    if (!result.finalKda)
      throw new Error(
        'K/D/A를 읽지 못했습니다. 숫자 세 개와 / 구분자만 포함하도록 HUD 영역을 조정하세요.',
      );
    return { ...result, samples, workers, interval };
  } finally {
    await Promise.allSettled(batch);
    await pool.terminate();
  }
}
