import http from 'node:http';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, writeFile, readdir, stat, rename } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { probe, frame, run, bin, isSupportedVideo } from './media.js';
import { analyze, ocrPool, readKda } from './analyzer.js';
import {
  VERSION,
  DEFAULT_ROI,
  cacheKey,
  planClips,
  trimPlan,
  normalizeEvents,
  number,
  roiPixels,
} from './core.js';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const STORE = process.env.EOL_DATA_DIR
  ? path.resolve(process.env.EOL_DATA_DIR)
  : path.join(ROOT, '.eol');
export async function atomicJson(file, value) {
  const tmp = `${file}.${randomUUID()}.tmp`;
  await writeFile(tmp, JSON.stringify(value, null, 2));
  await rename(tmp, file);
}

export async function createApp({
  port = 4317,
  token = randomBytes(24).toString('hex'),
  stateDir = STORE,
} = {}) {
  const STORE = stateDir;
  await mkdir(path.join(STORE, 'jobs'), { recursive: true });
  await mkdir(path.join(STORE, 'cache'), { recursive: true });
  const sources = new Map(),
    jobs = new Map(),
    controllers = new Map();
  let active = null;
  for (const name of await readdir(path.join(STORE, 'jobs'))) {
    if (!name.endsWith('.json')) continue;
    try {
      const job = JSON.parse(await readFile(path.join(STORE, 'jobs', name), 'utf8'));
      if (!['done', 'failed', 'cancelled'].includes(job.status)) {
        job.status = 'failed';
        job.error = '엔진이 종료되어 작업이 중단되었습니다. 다시 분석하세요.';
      }
      jobs.set(job.id, job);
      sources.set(job.source.id, job.source);
    } catch {
      /* Ignore interrupted/corrupt files; never trust them as completed work. */
    }
  }
  const persist = (job) => atomicJson(path.join(STORE, 'jobs', `${job.id}.json`), job);
  const summary = (job) => {
    const { samples, ...result } = job.result ?? {};
    return { ...job, result };
  };
  const getSource = (id) => {
    const source = sources.get(id);
    if (!source) throw new Error('소스를 다시 불러오세요.');
    return source;
  };
  const getJob = (id) => {
    const job = jobs.get(id);
    if (!job) throw new Error('작업을 찾을 수 없습니다.');
    return job;
  };
  async function verifySource(source) {
    const current = await stat(source.path);
    if (current.size !== source.size || current.mtimeMs !== source.modified)
      throw new Error('원본 파일이 변경되었습니다. 다시 불러와 분석하세요.');
  }
  async function perform(job, signal) {
    try {
      await verifySource(job.source);
      const key = cacheKey(job.source, job.options.roi, job.options.interval);
      const cacheFile = path.join(STORE, 'cache', `${key}.json`);
      let cached;
      try {
        cached = JSON.parse(await readFile(cacheFile, 'utf8'));
      } catch {
        /* cold cache */
      }
      if (cached) {
        job.result = cached;
        job.cached = true;
      } else {
        job.result = await analyze(job.source, job.options, signal, (p) => Object.assign(job, p));
        if (!signal.aborted) await atomicJson(cacheFile, job.result);
      }
      if (signal.aborted) throw new Error('분석을 취소했습니다.');
      job.events = job.result.events;
      job.status = 'done';
      job.stage = '분석 완료';
      job.progress = 1;
    } catch (e) {
      job.status = signal.aborted ? 'cancelled' : 'failed';
      job.error = e.message;
      job.stage = job.status === 'cancelled' ? '취소됨' : '오류';
    } finally {
      job.elapsedMs = Date.now() - job.startedAt;
      active = null;
      controllers.delete(job.id);
      await persist(job);
    }
  }
  const json = (res, data, status = 200) => {
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    res.end(JSON.stringify(data));
  };
  const body = async (req) => {
    if (!req.headers['content-type']?.startsWith('application/json'))
      throw new Error('JSON 요청이 필요합니다.');
    const chunks = [];
    let size = 0;
    for await (const c of req) {
      size += c.length;
      if (size > 2 * 1024 * 1024) throw new Error('요청이 너무 큽니다.');
      chunks.push(c);
    }
    return JSON.parse(Buffer.concat(chunks).toString() || '{}');
  };
  const server = http.createServer(async (req, res) => {
    try {
      const boundPort = server.address()?.port ?? port;
      const host = `127.0.0.1:${boundPort}`;
      if (req.url?.split('?')[0] === '/api/health')
        console.log(
          `[health] ${req.method} host=${req.headers.host ?? '-'} origin=${req.headers.origin ?? '-'}`,
        );
      if (req.headers.host !== host && req.headers.host !== `localhost:${boundPort}`)
        return json(res, { error: '허용되지 않은 호스트' }, 403);
      const origin = req.headers.origin;
      let allowedOrigin = !origin || origin === 'null' || !/^https?:/i.test(origin);
      if (origin && /^https?:/i.test(origin)) {
        try {
          const parsedOrigin = new URL(origin);
          allowedOrigin =
            ['127.0.0.1', 'localhost'].includes(parsedOrigin.hostname) &&
            Number(parsedOrigin.port || (parsedOrigin.protocol === 'https:' ? 443 : 80)) ===
              boundPort;
        } catch {
          allowedOrigin = false;
        }
      }
      if (!allowedOrigin) return json(res, { error: '허용되지 않은 출처' }, 403);
      // Premiere UXP may use a host-specific origin instead of a browser-style
      // http origin. The server is loopback-only and every API route still
      // requires the random bearer token from connection.json.
      if (origin) {
        res.setHeader('Access-Control-Allow-Origin', origin);
        res.setHeader('Vary', 'Origin');
      }
      res.setHeader('X-Content-Type-Options', 'nosniff');
      res.setHeader('Referrer-Policy', 'no-referrer');
      const url = new URL(req.url, `http://${host}`);
      if (req.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
        res.writeHead(204, {
          'Access-Control-Allow-Headers': 'Authorization, Content-Type',
          'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
          'Access-Control-Allow-Private-Network': 'true',
          'Access-Control-Max-Age': '600',
        });
        res.end();
        return;
      }
      if (!url.pathname.startsWith('/api/')) return json(res, { error: 'Not found' }, 404);
      const provided =
        req.headers.authorization?.replace(/^Bearer /, '') ||
        (url.pathname.startsWith('/api/media/') ? url.searchParams.get('access') : null);
      if (
        !provided ||
        Buffer.byteLength(provided) !== Buffer.byteLength(token) ||
        !timingSafeEqual(Buffer.from(provided), Buffer.from(token))
      )
        return json(
          res,
          { error: '엔진 연결 파일을 선택하거나 실행 창의 주소로 접속하세요.' },
          401,
        );
      const parts = url.pathname.split('/').filter(Boolean),
        id = parts[2];
      if (req.method === 'GET' && url.pathname === '/api/health') {
        const tools = await Promise.allSettled(
          ['ffmpeg', 'ffprobe'].map((n) => run(bin(n), ['-version'], { maxBytes: 1024 * 1024 })),
        );
        return json(res, {
          version: VERSION,
          ffmpeg: tools[0].status === 'fulfilled',
          ffprobe: tools[1].status === 'fulfilled',
          active,
          defaultRoi: DEFAULT_ROI,
        });
      }
      if (req.method === 'GET' && url.pathname === '/api/files') {
        let names = [];
        try {
          names = (await readdir(path.join(ROOT, 'src-video'))).filter(isSupportedVideo);
        } catch {}
        return json(
          res,
          names.map((name) => ({ name, path: path.join(ROOT, 'src-video', name) })),
        );
      }
      if (req.method === 'POST' && url.pathname === '/api/sources') {
        const b = await body(req),
          source = { ...(await probe(b.path, b)), id: randomUUID() };
        sources.set(source.id, source);
        return json(res, source);
      }
      if (req.method === 'POST' && url.pathname === '/api/preview') {
        const b = await body(req),
          s = getSource(b.sourceId);
        await verifySource(s);
        const data = await frame(s, b.time, b.roi ?? null);
        return json(res, { image: `data:image/png;base64,${data.toString('base64')}` });
      }
      if (req.method === 'POST' && url.pathname === '/api/ocr') {
        if (active) throw new Error('분석 완료 후 판독 테스트를 실행하세요.');
        const b = await body(req),
          s = getSource(b.sourceId);
        await verifySource(s);
        const data = await frame(s, b.time, b.roi);
        const pool = await ocrPool();
        try {
          return json(res, await readKda(pool, data));
        } finally {
          await pool.terminate();
        }
      }
      if (req.method === 'GET' && parts[1] === 'media') {
        const s = getSource(id);
        await verifySource(s);
        const range = req.headers.range;
        let start = 0,
          end = s.size - 1;
        if (range) {
          const m = /^bytes=(\d+)-(\d*)$/.exec(range);
          if (!m) {
            res.writeHead(416);
            res.end();
            return;
          }
          start = +m[1];
          end = m[2] ? Math.min(+m[2], end) : end;
          if (start > end) {
            res.writeHead(416, { 'Content-Range': `bytes */${s.size}` });
            res.end();
            return;
          }
        }
        res.writeHead(range ? 206 : 200, {
          'Content-Type':
            path.extname(s.path).toLowerCase() === '.mkv' ? 'video/x-matroska' : 'video/mp4',
          'Accept-Ranges': 'bytes',
          'Content-Length': end - start + 1,
          ...(range ? { 'Content-Range': `bytes ${start}-${end}/${s.size}` } : {}),
        });
        const stream = createReadStream(s.path, { start, end });
        stream.on('error', () => res.destroy());
        res.on('close', () => stream.destroy());
        stream.pipe(res);
        return;
      }
      if (req.method === 'GET' && url.pathname === '/api/jobs')
        return json(res, [...jobs.values()].sort((a, b) => b.startedAt - a.startedAt).map(summary));
      if (req.method === 'POST' && url.pathname === '/api/jobs') {
        if (active) return json(res, { error: '이미 분석 중인 작업이 있습니다.' }, 409);
        const b = await body(req),
          source = getSource(b.sourceId);
        const options = {
          roi: b.roi ?? DEFAULT_ROI,
          interval: number(b.interval ?? 0.5, '샘플 간격', 0.25, 2),
          workers: b.workers ?? 'auto',
        };
        roiPixels(options.roi, source.width, source.height);
        if (options.workers !== 'auto') number(options.workers, '워커', 1, 8);
        const job = {
          id: randomUUID(),
          source,
          options,
          status: 'running',
          stage: '준비',
          progress: 0,
          startedAt: Date.now(),
          events: [],
        };
        const controller = new AbortController();
        jobs.set(job.id, job);
        controllers.set(job.id, controller);
        active = job.id;
        await persist(job);
        void perform(job, controller.signal).catch((e) =>
          console.error('작업 저장 실패:', e.message),
        );
        return json(res, summary(job), 202);
      }
      if (parts[1] === 'jobs' && id) {
        const job = getJob(id);
        if (req.method === 'GET') return json(res, summary(job));
        if (req.method === 'POST' && parts[3] === 'cancel') {
          controllers.get(id)?.abort();
          return json(res, { ok: true });
        }
        if (req.method === 'PATCH') {
          if (job.status !== 'done') throw new Error('완료된 분석만 수정할 수 있습니다.');
          const b = await body(req),
            events = normalizeEvents(b.events, job.source.in, job.source.out);
          if (b.settings) planClips(events, job.source, b.settings);
          if (
            JSON.stringify(events) !== JSON.stringify(job.events) ||
            (b.settings && JSON.stringify(b.settings) !== JSON.stringify(job.settings))
          )
            job.overrides = {};
          job.events = events;
          if (b.settings) job.settings = b.settings;
          await persist(job);
          return json(res, summary(job));
        }
        if (req.method === 'POST' && parts[3] === 'plan') {
          if (job.status !== 'done') throw new Error('분석을 먼저 완료하세요.');
          await verifySource(job.source);
          const b = await body(req);
          const settings = b.settings ?? job.settings ?? {};
          const sameSettings = JSON.stringify(settings) === JSON.stringify(job.settings);
          const overrides = b.overrides ?? (sameSettings ? job.overrides : {});
          const plan = trimPlan(planClips(job.events, job.source, settings), overrides, job.source);
          job.settings = settings;
          job.overrides = overrides ?? {};
          await persist(job);
          return json(res, { ...plan, source: job.source, jobId: job.id, version: VERSION });
        }
      }
      json(res, { error: 'Not found' }, 404);
    } catch (e) {
      if (!res.headersSent) json(res, { error: e.message }, 400);
      else res.destroy();
    }
  });
  return {
    server,
    token,
    jobs,
    close: async () => {
      for (const c of controllers.values()) c.abort();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.EOL_PORT || 4317);
  const configuredToken = process.env.EOL_AUTH_TOKEN;
  if (configuredToken && !/^[a-f0-9]{64,128}$/i.test(configuredToken)) {
    console.error('EOL_AUTH_TOKEN must be a 64-128 character hexadecimal value.');
    process.exit(2);
  }
  const app = await createApp({
    port,
    token: configuredToken || randomBytes(24).toString('hex'),
    stateDir: STORE,
  });
  app.server.on('error', (e) => {
    console.error(`엔진 시작 실패: ${e.message}`);
    process.exitCode = 1;
  });
  app.server.listen(port, '127.0.0.1', async () => {
    await atomicJson(path.join(STORE, 'connection.json'), {
      url: `http://localhost:${port}`,
      token: app.token,
      version: VERSION,
    });
    console.log(
      `EditOfLegends ${VERSION} (${os.platform()})\n검토 화면: http://localhost:${port}/#${app.token}\nPremiere 연결 파일: ${path.join(STORE, 'connection.json')}\n종료: Ctrl+C`,
    );
  });
  process.on('SIGINT', async () => {
    await app.close();
    process.exit(0);
  });
}
