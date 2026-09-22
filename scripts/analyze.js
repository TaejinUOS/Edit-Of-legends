import { probe } from '../engine/media.js';
import { analyze } from '../engine/analyzer.js';
import { DEFAULT_ROI, planClips } from '../engine/core.js';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { cacheKey } from '../engine/core.js';
const file = process.argv[2];
if (!file) {
  console.error('사용: npm run analyze -- <영상.mp4 또는 영상.mkv> [시작초] [끝초]');
  process.exit(1);
}
const source = await probe(file, {
  in: Number(process.argv[3] ?? 0),
  ...(process.argv[4] ? { out: Number(process.argv[4]) } : {}),
});
const controller = new AbortController();
process.on('SIGINT', () => controller.abort());
const startedAt = Date.now();
let last = 0;
const result = await analyze(
  source,
  { roi: DEFAULT_ROI, workers: 'auto', interval: 0.5 },
  controller.signal,
  (p) => {
    if (Date.now() - last > 5000 || p.progress === 0) {
      console.log(p.stage, Math.round(p.progress * 100) + '%');
      last = Date.now();
    }
  },
);
const plan = planClips(result.events, source);
await mkdir('.eol', { recursive: true });
await writeFile('.eol/analysis-report.json', JSON.stringify({ source, result, plan }, null, 2));
const id = randomUUID(),
  options = { roi: DEFAULT_ROI, workers: 'auto', interval: 0.5 };
source.id = randomUUID();
await mkdir('.eol/jobs', { recursive: true });
await mkdir('.eol/cache', { recursive: true });
await writeFile(
  `.eol/cache/${cacheKey(source, options.roi, options.interval)}.json`,
  JSON.stringify(result),
);
await writeFile(
  `.eol/jobs/${id}.json`,
  JSON.stringify(
    {
      id,
      source,
      options,
      result,
      events: result.events,
      status: 'done',
      stage: '분석 완료',
      progress: 1,
      startedAt,
      elapsedMs: Date.now() - startedAt,
    },
    null,
    2,
  ),
);
console.log(
  JSON.stringify(
    {
      finalKda: result.finalKda,
      events: result.events.length,
      review: result.events.filter((e) => e.review).length,
      readableRatio: result.readableRatio,
      clips: plan.clips.length,
      duration: plan.duration,
      elapsedSeconds: (Date.now() - startedAt) / 1000,
      warnings: result.warnings,
    },
    null,
    2,
  ),
);
