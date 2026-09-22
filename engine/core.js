import { createHash } from 'node:crypto';

export const VERSION = '0.2.2';
// Bump only when OCR, sampling, event detection, or cached result compatibility changes.
// App releases and performance-only changes must not invalidate analysis results.
export const ANALYSIS_REVISION = 5;
export const TYPES = ['kill', 'death', 'assist', 'flash'];
export const TRACKS = { kill: 0, assist: 1, death: 2, flash: 3 };
export const FLASH_ROIS = {
  D: { x: 0.516, y: 0.916, width: 0.015, height: 0.026 },
  F: { x: 0.535, y: 0.916, width: 0.015, height: 0.026 },
};

export const FLASH_ROIS_1080 = {
  D: { x: 0.509, y: 0.915, width: 0.015, height: 0.026 },
  F: { x: 0.528, y: 0.915, width: 0.015, height: 0.026 },
};

export function defaultFlashRois(source) {
  return source?.width === 1920 && source?.height === 1080 ? FLASH_ROIS_1080 : FLASH_ROIS;
}

export function flashOptions(value = {}, source) {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('점멸 분석 설정이 올바르지 않습니다.');
  const enabled = value.enabled ?? true;
  const slot = value.slot ?? 'F';
  if (typeof enabled !== 'boolean' || !['D', 'F'].includes(slot))
    throw new Error('점멸 슬롯은 D 또는 F여야 합니다.');
  const legacyDefault =
    value.roi &&
    Object.keys(FLASH_ROIS[slot]).every(
      (key) => Math.abs(value.roi[key] - FLASH_ROIS[slot][key]) < 1e-8,
    );
  const roi = !value.roi || legacyDefault ? defaultFlashRois(source)[slot] : value.roi;
  roiPixels(roi, 2560, 1440);
  return { enabled, slot, roi };
}
export const OPENING_GAME_START = 50;
export const OPENING_GAME_END = 210;
export const DEFAULT_ROI = { x: 0.867, y: 0.001, width: 0.039, height: 0.022 };
export const DEFAULT_ROI_1080 = { ...DEFAULT_ROI, x: 0.86 };

export function defaultKdaRoi(source) {
  return source.width === 1920 && source.height === 1080 ? DEFAULT_ROI_1080 : DEFAULT_ROI;
}

export function resolveKdaRoi(source, roi) {
  // Migrate the old universal preset, including percentages round-tripped by
  // the panel. Preserve user-defined crop coordinates.
  const legacyDefault =
    roi && Object.keys(DEFAULT_ROI).every((key) => Math.abs(roi[key] - DEFAULT_ROI[key]) < 1e-8);
  return !roi || legacyDefault ? defaultKdaRoi(source) : roi;
}
// Exclude the clock icon on the left and the FPS/ping row below the digits.
export const DEFAULT_CLOCK_ROI = { x: 0.968, y: 0.001, width: 0.025, height: 0.019 };

export function number(value, name, min, max) {
  const n = Number(value);
  if (value === null || value === '' || !Number.isFinite(n) || n < min || n > max)
    throw new Error(`${name}: ${min}–${max} 범위의 숫자가 필요합니다.`);
  return n;
}

export function roiPixels(roi, width, height) {
  const r = {};
  for (const k of ['x', 'y', 'width', 'height']) r[k] = number(roi[k], `HUD ${k}`, 0, 1);
  if (r.width < 0.005 || r.height < 0.005 || r.x + r.width > 1.000001 || r.y + r.height > 1.000001)
    throw new Error('HUD 영역은 화면 안에 있어야 합니다.');
  return {
    x: Math.floor(r.x * width),
    y: Math.floor(r.y * height),
    width: Math.max(2, Math.floor(r.width * width)),
    height: Math.max(2, Math.floor(r.height * height)),
  };
}

export function parseKda(text) {
  const match = text
    .trim()
    .replace(/\s/g, '')
    .match(/^(\d{1,2})\/(\d{1,2})\/(\d{1,2})$/);
  return match ? match.slice(1).map(Number) : null;
}

export function parseGameClock(text) {
  const match = text
    .trim()
    .replace(/\s/g, '')
    .match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const minutes = Number(match[1]),
    seconds = Number(match[2]);
  return minutes < 60 && seconds < 60 ? minutes * 60 + seconds : null;
}

export function detectOpeningWindow(samples, source) {
  const valid = samples.filter(
    (s) =>
      Number.isFinite(s.time) &&
      Number.isInteger(s.clockSeconds) &&
      s.clockSeconds >= 0 &&
      s.clockSeconds <= 3600 &&
      s.confidence >= 35,
  );
  let best = [];
  for (const sample of valid) {
    const offset = sample.time - sample.clockSeconds;
    const group = valid.filter(
      (other) => Math.abs(other.time - other.clockSeconds - offset) <= 1.5,
    );
    if (group.length > best.length) best = group;
  }
  if (
    best.length < 5 ||
    Math.max(...best.map((s) => s.time)) - Math.min(...best.map((s) => s.time)) < 20
  )
    throw new Error(
      '인게임 시간 HUD를 안정적으로 읽지 못했습니다. 시계 영역을 확인하고 다시 분석하세요.',
    );
  const offsets = best.map((s) => s.time - s.clockSeconds).sort((a, b) => a - b);
  const offset = offsets[Math.floor(offsets.length / 2)];
  const start = Math.max(source.in, offset + OPENING_GAME_START);
  const end = Math.min(source.out, offset + OPENING_GAME_END);
  if (end <= start)
    throw new Error('선택한 원본 구간에 인게임 0:50–3:30이 없습니다. 원본 범위를 확인하세요.');
  return { in: start, out: end, offset, samples: best.length };
}

// Two consecutive observations confirm a value; keep the FIRST observation's timestamp.
export function detectEvents(samples, interval = 0.5) {
  let baseline = null,
    lastStable = null,
    pending = null,
    stopped = false;
  const events = [],
    warnings = [];
  let readable = 0;
  for (const [index, s] of samples.entries()) {
    if (!s.kda || s.confidence < 25) {
      pending = null;
      continue;
    }
    readable++;
    const key = s.kda.join('/');
    if (!pending || pending.key !== key) pending = { key, first: s.time, count: 1, kda: s.kda };
    else pending.count++;
    if (pending.count < 2 || stopped) continue;
    if (!baseline) {
      baseline = [...s.kda];
      lastStable = s.time;
      continue;
    }
    const delta = s.kda.map((v, i) => v - baseline[i]);
    // A confirmed correction shortly afterwards invalidates a transient OCR jump.
    // Look ahead only within ten seconds; never fabricate an event timestamp.
    if (delta.some((v) => v !== 0)) {
      let correction = false;
      for (
        let j = index + 1;
        j + 1 < samples.length && samples[j].time <= pending.first + 10;
        j++
      ) {
        const a = samples[j],
          b = samples[j + 1];
        if (
          !a.kda ||
          !b.kda ||
          a.confidence < 25 ||
          b.confidence < 25 ||
          a.kda.join('/') !== b.kda.join('/')
        )
          continue;
        if (
          a.kda.every((v, i) => v >= baseline[i]) &&
          (delta.some((v) => v < 0) || a.kda.some((v, i) => v < s.kda[i]))
        ) {
          correction = true;
          break;
        }
      }
      if (correction) continue;
    }
    if (delta.some((v) => v < 0)) {
      if (pending.count >= 4) {
        warnings.push({
          time: pending.first,
          message: 'K/D/A 감소가 지속됩니다. 화면 전환 이후 자동 확정을 중단했습니다.',
        });
        stopped = true;
      }
      continue;
    }
    if (delta.some((v) => v > 0)) {
      const gap = pending.first - lastStable > interval * 3;
      const large = delta.some((v) => v > 3);
      for (let i = 0; i < 3; i++)
        if (delta[i] > 0) {
          const review = gap || large || delta[i] > 1;
          events.push({
            id: `evt-${events.length + 1}`,
            type: TYPES[i],
            time: pending.first,
            amount: delta[i],
            before: [...baseline],
            after: [...s.kda],
            confidence: s.confidence,
            review,
            included: !review,
            range: gap ? [lastStable, pending.first] : null,
            reason: gap
              ? '판독 공백 이후 증가 — 시점 확인 필요'
              : large || delta[i] > 1
                ? '여러 증가량 — 개별 시점 확인 필요'
                : '',
          });
        }
      baseline = [...s.kda];
    }
    lastStable = s.time;
  }
  return {
    events,
    warnings,
    readableRatio: samples.length ? readable / samples.length : 0,
    finalKda: baseline,
    stopped,
    sampleCount: samples.length,
  };
}

export function normalizeEvents(events, start, end) {
  if (!Array.isArray(events) || events.length > 10000)
    throw new Error('이벤트 목록이 올바르지 않습니다.');
  const ids = new Set();
  return events.map((e, i) => {
    if (!TYPES.includes(e.type)) throw new Error('알 수 없는 이벤트 유형입니다.');
    const id = String(e.id ?? `manual-${i}`);
    if (ids.has(id)) throw new Error('중복된 이벤트 ID입니다.');
    ids.add(id);
    return {
      ...e,
      id,
      time: number(e.time, '이벤트 시각', start, end),
      amount: number(e.amount ?? 1, '증가량', 1, 99),
      included: e.included !== false,
    };
  });
}

export function planClips(events, source, settings = {}) {
  const before = number(settings.before ?? 11, 'Before', 0, 120);
  const after = number(settings.after ?? 7, 'After', 0, 120);
  const gap = number(settings.gap ?? 15, '동시 판정', 0, 60);
  if (before + after <= 0) throw new Error('앞뒤 보존 시간 중 하나는 0보다 커야 합니다.');
  const types = settings.types ?? TYPES;
  if (!Array.isArray(types) || types.some((t) => !TYPES.includes(t)))
    throw new Error('이벤트 유형이 올바르지 않습니다.');
  const start = source.in ?? 0,
    end = source.out ?? source.duration;
  const fps = source.fpsNum / source.fpsDen;
  const opening = source.openingWindow;
  if (
    !opening ||
    !Number.isFinite(opening.in) ||
    !Number.isFinite(opening.out) ||
    opening.in < start ||
    opening.out > end ||
    opening.out <= opening.in
  )
    throw new Error('인게임 시간 분석 결과가 없습니다. 영상을 다시 분석하세요.');
  const lo = Math.max(0, Math.ceil(start * fps - 1e-7)),
    hi = Math.floor(end * fps + 1e-7);
  const openingStart = Math.max(lo, Math.floor(opening.in * fps + 1e-7));
  const openingEnd = Math.min(hi, Math.ceil(opening.out * fps - 1e-7));
  const selected = normalizeEvents(events, start, end)
    .filter((e) => e.included && types.includes(e.type) && e.time >= openingEnd / fps)
    .sort((a, b) => a.time - b.time);
  const groups = [];
  for (const e of selected) {
    const prev = groups.at(-1);
    if (prev && e.time - prev.at(-1).time <= gap) prev.push(e);
    else groups.push([e]);
  }
  const clips = [];
  if (openingEnd > openingStart)
    clips.push({ inFrame: openingStart, outFrame: openingEnd, events: [], type: 'opening' });
  for (const group of groups) {
    const a = Math.max(openingEnd, Math.floor((group[0].time - before) * fps + 1e-7));
    const b = Math.min(hi, Math.ceil((group.at(-1).time + after) * fps - 1e-7));
    if (b <= a) continue;
    const prev = clips.at(-1);
    if (prev && prev.type !== 'opening' && a <= prev.outFrame) {
      prev.outFrame = Math.max(b, prev.outFrame);
      prev.events.push(...group);
    } else clips.push({ inFrame: a, outFrame: b, events: [...group] });
  }
  let cursor = 0;
  for (const c of clips) {
    if (c.type !== 'opening')
      c.type = [...c.events].sort((a, b) => TRACKS[a.type] - TRACKS[b.type])[0].type;
    c.track = c.type === 'opening' ? 0 : TRACKS[c.type];
    c.eventIds = c.events.map((e) => e.id);
    delete c.events;
    c.outputInFrame = cursor;
    cursor += c.outFrame - c.inFrame;
    c.outputOutFrame = cursor;
    c.in = c.inFrame / fps;
    c.out = c.outFrame / fps;
    c.long = c.type !== 'opening' && c.out - c.in > 120;
  }
  return {
    clips,
    frames: cursor,
    duration: cursor / fps,
    fpsNum: source.fpsNum,
    fpsDen: source.fpsDen,
  };
}

export function cacheKey(source, roi, interval, clockRoi = DEFAULT_CLOCK_ROI, flash = {}) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        analysisRevision: ANALYSIS_REVISION,
        path: source.path,
        size: source.size,
        modified: source.modified,
        in: source.in,
        out: source.out,
        roi,
        clockRoi,
        flash: flashOptions(flash),
        interval,
      }),
    )
    .digest('hex');
}

export function trimPlan(plan, overrides, source) {
  const fps = plan.fpsNum / plan.fpsDen;
  let cursor = 0,
    lastOut = -1;
  const clips = plan.clips.map((c) => {
    const key = c.type === 'opening' ? 'opening' : c.eventIds.join('|'),
      edit = overrides?.[key];
    if (c.type === 'opening' && edit) throw new Error('인게임 0:50–3:30 클립은 자를 수 없습니다.');
    let start = c.inFrame,
      end = c.outFrame;
    if (edit) {
      start = Math.max(
        Math.ceil(source.in * fps - 1e-7),
        Math.round(number(edit.in, '컷 시작', source.in, source.out) * fps),
      );
      end = Math.min(
        Math.floor(source.out * fps + 1e-7),
        Math.round(number(edit.out, '컷 끝', source.in, source.out) * fps),
      );
    }
    if (end <= start || start < lastOut)
      throw new Error('컷 길이는 0보다 커야 하며 앞뒤 컷과 겹칠 수 없습니다.');
    lastOut = end;
    const result = {
      ...c,
      key,
      inFrame: start,
      outFrame: end,
      in: start / fps,
      out: end / fps,
      outputInFrame: cursor,
      manual: !!edit,
    };
    cursor += end - start;
    result.outputOutFrame = cursor;
    return result;
  });
  return { ...plan, clips, frames: cursor, duration: cursor / fps };
}
