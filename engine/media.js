import { spawn } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { number, roiPixels } from './core.js';

export const bin = (name) => process.env[name.toUpperCase() + '_PATH'] || name;
export function run(command, args, { signal, maxBytes = 24 * 1024 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(command, args, { windowsHide: true, signal });
    const chunks = [];
    let size = 0,
      error = '';
    p.stdout.on('data', (b) => {
      size += b.length;
      if (size > maxBytes) p.kill();
      else chunks.push(b);
    });
    p.stderr.on('data', (b) => {
      error = (error + b).slice(-4000);
    });
    p.on('error', reject);
    p.on('close', (code) =>
      code === 0 && size <= maxBytes
        ? resolve(Buffer.concat(chunks))
        : reject(
            new Error(
              `${path.basename(command)} 실패 (${code}): ${error || '출력 제한 초과 또는 취소'}`,
            ),
          ),
    );
  });
}

export async function probe(file, range = {}) {
  if (typeof file !== 'string' || !file || /^(\\\\|\/\/|https?:)/i.test(file))
    throw new Error('로컬 MP4 파일 경로가 필요합니다.');
  const resolved = await realpath(file);
  const info = await stat(resolved);
  if (!info.isFile() || path.extname(resolved).toLowerCase() !== '.mp4')
    throw new Error('MP4 파일을 선택하세요.');
  const data = JSON.parse(
    await run(bin('ffprobe'), [
      '-v',
      'error',
      '-show_streams',
      '-show_format',
      '-of',
      'json',
      resolved,
    ]),
  );
  const video = data.streams.find((s) => s.codec_type === 'video');
  if (!video || video.codec_name !== 'h264') throw new Error('MVP는 H.264 영상만 지원합니다.');
  if (
    ![
      [1920, 1080],
      [2560, 1440],
    ].some(([w, h]) => video.width === w && video.height === h)
  )
    throw new Error('1920×1080 또는 2560×1440 영상이 필요합니다.');
  const [fpsNum, fpsDen] = video.avg_frame_rate.split('/').map(Number);
  if (fpsDen !== 1 || ![30, 60].includes(fpsNum) || video.r_frame_rate !== video.avg_frame_rate)
    throw new Error('고정 30/60fps만 지원합니다. VFR 입력은 CFR로 변환한 사본을 사용하세요.');
  const duration = Number(video.duration ?? data.format.duration);
  const start = number(range.in ?? 0, '시작', 0, duration);
  const end = number(range.out ?? duration, '끝', 0, duration);
  if (end <= start || end - start > 7200)
    throw new Error('분석 범위는 0초 초과, 2시간 이하여야 합니다.');
  if (Math.abs(Number(video.start_time ?? 0)) > 1 / fpsNum)
    throw new Error('0초에서 시작하는 미디어만 지원합니다.');
  const audio = data.streams
    .filter((s) => s.codec_type === 'audio')
    .map((s) => ({
      index: s.index,
      channels: s.channels,
      sampleRate: +s.sample_rate,
      codec: s.codec_name,
      start: +(s.start_time ?? 0),
    }));
  if (
    audio.some(
      (s) => s.codec !== 'aac' || ![1, 2].includes(s.channels) || Math.abs(s.start) > 1 / fpsNum,
    )
  )
    throw new Error('동기화된 모노/스테레오 AAC 오디오만 지원합니다.');
  return {
    path: resolved,
    name: path.basename(resolved),
    size: info.size,
    modified: info.mtimeMs,
    duration,
    in: start,
    out: end,
    width: video.width,
    height: video.height,
    fpsNum,
    fpsDen,
    audio,
  };
}

export async function verifyCfr(source, signal) {
  // Check packet durations too: equal nominal/average rates alone do not prove CFR.
  const out = await run(
    bin('ffprobe'),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      'packet=duration_time',
      '-of',
      'csv=p=0',
      source.path,
    ],
    { signal },
  );
  const durations = out.toString().trim().split(/\r?\n/).map(Number);
  const expected = source.fpsDen / source.fpsNum;
  if (
    !durations.length ||
    durations.some((v) => !Number.isFinite(v) || Math.abs(v - expected) > 0.00001)
  )
    throw new Error('가변 프레임 간격이 감지되었습니다. CFR 사본으로 다시 시도하세요.');
}

export async function frame(source, time, roi = null) {
  const t = number(
    time,
    '프레임 시각',
    source.in,
    Math.max(source.in, source.out - 1 / source.fpsNum),
  );
  const filters = [];
  if (roi) {
    const r = roiPixels(roi, source.width, source.height);
    filters.push(`crop=${r.width}:${r.height}:${r.x}:${r.y}`);
  } else filters.push('scale=960:-1');
  return run(bin('ffmpeg'), [
    '-hide_banner',
    '-loglevel',
    'error',
    '-ss',
    String(t),
    '-i',
    source.path,
    '-frames:v',
    '1',
    '-vf',
    filters.join(','),
    '-f',
    'image2pipe',
    '-vcodec',
    'png',
    'pipe:1',
  ]);
}

export async function* sampleFrames(source, roi, interval, signal) {
  const r = roiPixels(roi, source.width, source.height),
    bytes = r.width * r.height;
  const p = spawn(
    bin('ffmpeg'),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      '2',
      '-ss',
      String(source.in),
      '-i',
      source.path,
      '-t',
      String(source.out - source.in),
      '-an',
      '-vf',
      `fps=${1 / interval}:start_time=0:round=up,crop=${r.width}:${r.height}:${r.x}:${r.y},format=gray`,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      'pipe:1',
    ],
    { windowsHide: true, signal },
  );
  let error = '',
    buffer = Buffer.alloc(0),
    index = 0;
  const completed = new Promise((resolve) => {
    p.on('error', (e) => {
      error = e.message;
      resolve(-1);
    });
    p.on('close', resolve);
  });
  p.stderr.on('data', (b) => {
    error = (error + b).slice(-4000);
  });
  try {
    for await (const chunk of p.stdout) {
      buffer = Buffer.concat([buffer, chunk]);
      while (buffer.length >= bytes) {
        if (signal?.aborted) throw new Error('분석을 취소했습니다.');
        const raw = buffer.subarray(0, bytes);
        buffer = buffer.subarray(bytes);
        const time = source.in + index++ * interval;
        if (time < source.out) yield { raw, width: r.width, height: r.height, time };
      }
    }
    const code = await completed;
    if (code !== 0) throw new Error(`프레임 읽기 실패: ${error}`);
  } finally {
    if (p.exitCode === null) p.kill();
    await completed;
  }
}
