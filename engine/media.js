import { spawn } from 'node:child_process';
import { stat, realpath } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { number, roiPixels } from './core.js';

const require = createRequire(import.meta.url);
const bundledBins = {
  ffmpeg: require('ffmpeg-static'),
  ffprobe: require('ffprobe-static').path,
};

export const bin = (name) => process.env[name.toUpperCase() + '_PATH'] || bundledBins[name] || name;
export const isSupportedVideo = (file) =>
  ['.mp4', '.mkv'].includes(path.extname(file).toLowerCase());
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
    throw new Error('로컬 MP4 또는 MKV 파일 경로가 필요합니다.');
  const resolved = await realpath(file);
  const info = await stat(resolved);
  if (!info.isFile() || !isSupportedVideo(resolved))
    throw new Error('MP4 또는 MKV 파일을 선택하세요.');
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
  // MKV can retain one AAC encoder-delay frame at the start (e.g. 21 ms
  // at 48 kHz), with millisecond rounding. Keep the original timestamps.
  const startTolerance =
    path.extname(resolved).toLowerCase() === '.mkv'
      ? Math.max(
          1 / fpsNum,
          ...data.streams
            .filter((s) => s.codec_type === 'audio' && s.codec_name === 'aac' && +s.sample_rate > 0)
            .map((s) => 1024 / +s.sample_rate),
        ) + 0.001
      : 1 / fpsNum;
  if (Math.abs(Number(video.start_time ?? 0)) > startTolerance)
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
      (s) =>
        s.codec !== 'aac' || ![1, 2].includes(s.channels) || Math.abs(s.start) > startTolerance,
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
  const isMkv = path.extname(source.path).toLowerCase() === '.mkv';
  // Check packet durations too: equal nominal/average rates alone do not prove CFR.
  const out = await run(
    bin('ffprobe'),
    [
      '-v',
      'error',
      '-select_streams',
      'v:0',
      '-show_entries',
      isMkv ? 'packet=pts_time' : 'packet=duration_time',
      '-of',
      'csv=p=0',
      source.path,
    ],
    { signal },
  );
  const values = out.toString().trim().split(/\r?\n/).map(Number);
  const expected = source.fpsDen / source.fpsNum;
  // Matroska timestamps are quantized to milliseconds. Sort presentation
  // timestamps because B-frames arrive in decode order; packet durations alone
  // can report a constant nominal interval even for variable-rate MKV files.
  if (isMkv) values.sort((a, b) => a - b);
  const invalid = isMkv
    ? values.some((v, i) => {
        if (!Number.isFinite(v)) return true;
        const drift = v - values[0] - i * expected;
        if (Math.abs(drift) <= 0.00101) return false;
        // OBS may omit up to two frames immediately before the final packet
        // when recording stops. Allow only that terminal gap, on the CFR grid.
        const missing = Math.round(drift / expected);
        return !(
          i === values.length - 1 &&
          i > 0 &&
          missing >= 1 &&
          missing <= 2 &&
          Math.abs(drift - missing * expected) <= 0.00101
        );
      })
    : values.some((v) => !Number.isFinite(v) || Math.abs(v - expected) > 0.00001);
  if (!out.toString().trim() || invalid)
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

export async function* sampleFrames(source, roi, interval, signal, threads = 4) {
  threads = Math.floor(number(threads, 'FFmpeg threads', 1, 8));
  // Multiple HUD regions share one decode pass. Stack the crops horizontally
  // instead of transferring the full frame between the top and bottom HUDs.
  const multiple = Array.isArray(roi);
  const regions = (multiple ? roi : [roi]).map((area) =>
    roiPixels(area, source.width, source.height),
  );
  const width = regions.reduce((sum, area) => sum + area.width, 0);
  const height = Math.max(...regions.map((area) => area.height));
  const bytes = width * height;
  const fpsFilter = `fps=${1 / interval}:start_time=0:round=up`;
  const filters =
    regions.length === 1
      ? [
          '-vf',
          `${fpsFilter},crop=${regions[0].width}:${regions[0].height}:${regions[0].x}:${regions[0].y},format=gray`,
        ]
      : [
          '-filter_complex_threads',
          '1',
          '-filter_complex',
          `[0:v]${fpsFilter},format=gray,split=${regions.length}${regions.map((_, i) => `[s${i}]`).join('')};` +
            regions
              .map(
                (r, i) =>
                  `[s${i}]crop=${r.width}:${r.height}:${r.x}:${r.y},pad=${r.width}:${height}:0:0[c${i}]`,
              )
              .join(';') +
            `;${regions.map((_, i) => `[c${i}]`).join('')}hstack=inputs=${regions.length}[hud]`,
          '-map',
          '[hud]',
        ];
  const p = spawn(
    bin('ffmpeg'),
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-threads',
      String(threads),
      '-ss',
      String(source.in),
      '-i',
      source.path,
      '-t',
      String(source.out - source.in),
      '-an',
      '-filter_threads',
      '1',
      ...filters,
      '-f',
      'rawvideo',
      '-pix_fmt',
      'gray',
      '-threads',
      '1',
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
        if (time < source.out) {
          if (!multiple) yield { raw, width, height, time };
          else {
            let left = 0;
            const crops = regions.map((r) => {
              const cropped = Buffer.allocUnsafe(r.width * r.height);
              for (let y = 0; y < r.height; y++)
                raw.copy(cropped, y * r.width, y * width + left, y * width + left + r.width);
              left += r.width;
              return { raw: cropped, width: r.width, height: r.height, time };
            });
            yield { time, regions: crops };
          }
        }
      }
    }
    const code = await completed;
    if (code !== 0) throw new Error(`프레임 읽기 실패: ${error}`);
  } finally {
    if (p.exitCode === null) p.kill();
    await completed;
  }
}
