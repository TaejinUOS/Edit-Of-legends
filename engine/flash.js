import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { parseGameClock, roiPixels } from './core.js';
import { sampleFrames } from './media.js';

// Ready-state reference cropped from the user's sample, excluding the F key label.
const reference = readFile(new URL('./assets/flash-ready.png', import.meta.url)).then((png) =>
  sharp(png).resize(8, 8).grayscale().raw().toBuffer(),
);

export async function locateFlash(raw, info, crop, signal) {
  const template = await reference;
  const image = sharp(raw, { raw: { width: info.width, height: info.height, channels: 1 } });
  let best = null;
  for (let y = 0; y <= info.height - crop.height; y++) {
    signal?.throwIfAborted();
    for (let x = 0; x <= info.width - crop.width; x++) {
      const pixels = await image.clone()
        .extract({ left: x, top: y, width: crop.width, height: crop.height })
        .resize(8, 8).grayscale().raw().toBuffer();
      const difference = pixels.reduce((sum, v, i) => sum + Math.abs(v - template[i]), 0) / (64 * 255);
      if (!best || difference < best.difference) best = { x, y, difference };
    }
  }
  return best;
}

export async function calibrateFlash(source, roi, signal, threads = 4) {
  const crop = roiPixels(roi, source.width, source.height);
  const margin = Math.ceil(8 * source.width / 1920);
  const left = Math.max(0, crop.x - margin), top = Math.max(0, crop.y - margin);
  const width = Math.min(source.width, crop.x + crop.width + margin) - left;
  const height = Math.min(source.height, crop.y + crop.height + margin) - top;
  const expanded = { x: left / source.width, y: top / source.height,
    width: width / source.width, height: height / source.height };
  let previous = null;
  // Sparse preflight stops after two matching ready icons. Cooldowns and death
  // screens cannot establish alignment; fall back to the supplied ROI if absent.
  for await (const frame of sampleFrames(source, expanded, 30, signal, threads)) {
    const match = await locateFlash(frame.raw, frame, crop, signal);
    if (!match || match.difference >= 0.10) { previous = null; continue; }
    if (previous && match.x === previous.x && match.y === previous.y) {
      return { roi: { x: (left + match.x) / source.width, y: (top + match.y) / source.height,
        width: crop.width / source.width, height: crop.height / source.height },
        calibrated: true, offset: { x: left + match.x - crop.x, y: top + match.y - crop.y } };
    }
    previous = match;
  }
  return { roi, calibrated: false, offset: { x: 0, y: 0 } };
}

export function parseCooldown(text) {
  const value = text.trim().replace(/\s/g, '');
  const seconds = value.includes(':')
    ? parseGameClock(value)
    : /^\d{1,3}$/.test(value)
      ? Number(value)
      : null;
  return seconds !== null && seconds > 0 && seconds <= 600 ? seconds : null;
}

export async function readFlash(pool, input, rawInfo) {
  const image = sharp(
    input,
    rawInfo ? { raw: { width: rawInfo.width, height: rawInfo.height, channels: 1 } } : undefined,
  );
  // Low-frequency appearance tolerates subpixel HUD/crop scaling differences.
  const pixels = await image.clone().resize(8, 8).grayscale().raw().toBuffer();
  const template = await reference;
  let difference = 0;
  for (let i = 0; i < pixels.length; i++) difference += Math.abs(pixels[i] - template[i]);
  difference /= pixels.length * 255;
  if (difference < 0.12)
    return { state: 'ready', cooldown: null, confidence: Math.round((1 - difference) * 100) };
  const { width, height } = rawInfo ?? (await image.metadata());
  const png = await image
    .extract({ left: 0, top: Math.floor(height * 0.25), width, height: Math.floor(height * 0.53) })
    .resize(width * 6)
    .grayscale()
    .negate()
    .normalize()
    .png()
    .toBuffer();
  const row = (await pool.addJob('recognize', png, { tessedit_pageseg_mode: 7 })).data;
  const cooldown = parseCooldown(row.text);
  return cooldown !== null && row.confidence >= 60
    ? { state: 'cooldown', cooldown, confidence: row.confidence }
    : { state: 'unknown', cooldown: null, confidence: 0 };
}

export function detectFlashEvents(samples, interval = 0.5) {
  const events = [];
  let readyCount = 0,
    lastReady = null,
    armed = false,
    pending = null,
    previousTime = null;
  for (const s of samples) {
    const contiguous = previousTime !== null && s.time - previousTime <= interval * 1.5;
    previousTime = s.time;
    if (s.state === 'ready') {
      readyCount = contiguous ? readyCount + 1 : 1;
      if (readyCount >= 2) armed = true;
      lastReady = s.time;
      pending = null;
      continue;
    }
    readyCount = 0;
    if (!armed || s.state !== 'cooldown' || s.cooldown < 30) {
      pending = null;
      continue;
    }
    if (
      !pending ||
      !contiguous ||
      s.cooldown > pending.lastCooldown ||
      Math.abs(pending.cooldown - s.cooldown - (s.time - pending.time)) > 1.5
    ) {
      pending = { ...s, count: 1, lastCooldown: s.cooldown };
      continue;
    }
    pending.count++;
    pending.lastCooldown = s.cooldown;
    // A decreasing countdown across at least a second rejects a one-frame
    // animation/OCR error and disabled (dead/silenced) icons without a timer.
    if (pending.count < 3 || s.time - pending.time < 1 || s.cooldown >= pending.cooldown) continue;
    const review = pending.time - lastReady > interval * 3;
    events.push({
      id: `flash-${events.length + 1}`,
      type: 'flash',
      time: pending.time,
      amount: 1,
      confidence: Math.min(pending.confidence, s.confidence),
      review,
      included: !review,
      range: [lastReady, pending.time],
      reason: review ? '점멸 HUD 판독 공백 — 사용 시점 확인 필요' : '',
    });
    armed = false;
    pending = null;
  }
  return events;
}
