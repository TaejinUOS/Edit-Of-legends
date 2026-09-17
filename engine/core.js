import { createHash } from 'node:crypto';

export const VERSION = '0.1.0';
export const TYPES = ['kill', 'death', 'assist'];
export const TRACKS = { kill: 0, assist: 1, death: 2 };
export const DEFAULT_ROI = { x: 0.867, y: 0.001, width: 0.039, height: 0.022 };

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
  if (!Array.isArray(types) || !types.length || types.some((t) => !TYPES.includes(t)))
    throw new Error('이벤트 유형을 하나 이상 선택하세요.');
  const start = source.in ?? 0,
    end = source.out ?? source.duration;
  const fps = source.fpsNum / source.fpsDen;
  const selected = normalizeEvents(events, start, end)
    .filter((e) => e.included && types.includes(e.type))
    .sort((a, b) => a.time - b.time);
  const groups = [];
  for (const e of selected) {
    const prev = groups.at(-1);
    if (prev && e.time - prev.at(-1).time <= gap) prev.push(e);
    else groups.push([e]);
  }
  const lo = Math.ceil(start * fps - 1e-7),
    hi = Math.floor(end * fps + 1e-7);
  const clips = [];
  for (const group of groups) {
    const a = Math.max(lo, Math.floor((group[0].time - before) * fps + 1e-7));
    const b = Math.min(hi, Math.ceil((group.at(-1).time + after) * fps - 1e-7));
    if (b <= a) continue;
    const prev = clips.at(-1);
    if (prev && a <= prev.outFrame) {
      prev.outFrame = Math.max(b, prev.outFrame);
      prev.events.push(...group);
    } else clips.push({ inFrame: a, outFrame: b, events: [...group] });
  }
  let cursor = 0;
  for (const c of clips) {
    c.type = [...c.events].sort((a, b) => TRACKS[a.type] - TRACKS[b.type])[0].type;
    c.track = TRACKS[c.type];
    c.eventIds = c.events.map((e) => e.id);
    delete c.events;
    c.outputInFrame = cursor;
    cursor += c.outFrame - c.inFrame;
    c.outputOutFrame = cursor;
    c.in = c.inFrame / fps;
    c.out = c.outFrame / fps;
    c.long = c.out - c.in > 120;
  }
  return {
    clips,
    frames: cursor,
    duration: cursor / fps,
    fpsNum: source.fpsNum,
    fpsDen: source.fpsDen,
  };
}

export function cacheKey(source, roi, interval) {
  return createHash('sha256')
    .update(
      JSON.stringify({
        version: VERSION,
        analysisRevision: 2,
        path: source.path,
        size: source.size,
        modified: source.modified,
        in: source.in,
        out: source.out,
        roi,
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
    const key = c.eventIds.join('|'),
      edit = overrides?.[key];
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
