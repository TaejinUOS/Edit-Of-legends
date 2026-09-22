import sharp from 'sharp';
import { readFile } from 'node:fs/promises';
import { parseGameClock } from './core.js';

// Ready-state reference cropped from the user's sample, excluding the F key label.
const reference = readFile(new URL('./assets/flash-ready.png', import.meta.url)).then((png) =>
  sharp(png).resize(8, 8).grayscale().raw().toBuffer(),
);

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
