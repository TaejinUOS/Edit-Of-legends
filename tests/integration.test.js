import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createApp } from '../engine/server.js';

const file = process.env.EOL_SAMPLE ?? path.resolve('src-video/예시녹화본1.mp4');
test(
  'real media API: preview, range streaming, analysis, cache and cancellation',
  { skip: !existsSync(file), timeout: 60000 },
  async () => {
    const stateDir = await mkdtemp(path.join(os.tmpdir(), 'eol-integration-'));
    const app = await createApp({ port: 0, token: 'integration-only', stateDir });
    await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
    const base = `http://127.0.0.1:${app.server.address().port}`;
    const request = (route, value) =>
      fetch(base + '/api/' + route, {
        method: value ? 'POST' : 'GET',
        headers: { Authorization: 'Bearer integration-only', 'Content-Type': 'application/json' },
        ...(value ? { body: JSON.stringify(value) } : {}),
      });
    const json = async (route, value) => {
      const response = await request(route, value);
      const data = await response.json();
      assert.ok(response.ok, JSON.stringify(data));
      return data;
    };
    const finish = async (id) => {
      const deadline = Date.now() + 45000;
      while (Date.now() < deadline) {
        const job = await json('jobs/' + id);
        if (job.status !== 'running') return job;
        await delay(100);
      }
      throw Error('Analysis timeout');
    };
    try {
      const source = await json('sources', { path: file, in: 283, out: 294 });
      const preview = await json('preview', { sourceId: source.id, time: 283 });
      assert.match(preview.image, /^data:image\/png;base64,/);
      const media = await fetch(base + '/api/media/' + source.id, {
        headers: { Authorization: 'Bearer integration-only', Range: 'bytes=0-31' },
      });
      assert.equal(media.status, 206);
      assert.equal((await media.arrayBuffer()).byteLength, 32);
      const first = await finish((await json('jobs', { sourceId: source.id, workers: 1 })).id);
      assert.equal(first.status, 'done', first.error);
      assert.deepEqual(first.result.finalKda, [0, 0, 0]);
      assert.equal(first.events.length, 1);
      assert.equal(first.events[0].type, 'flash');
      assert.equal(first.events[0].time, 291);
      assert.equal(first.events[0].included, true);
      assert.equal(first.options.flash.slot, 'F');
      assert.equal(first.result.openingWindow.in, 283);
      assert.equal(first.result.openingWindow.out, 293);
      const second = await finish((await json('jobs', { sourceId: source.id, workers: 1 })).id);
      assert.equal(second.cached, true);
      const long = await json('sources', { path: file });
      const flashPreview = await json('ocr', { sourceId: long.id, kind: 'flash', time: 300 });
      assert.equal(flashPreview.state, 'cooldown');
      assert.equal(flashPreview.cooldown, 245);
      const cancelled = await json('jobs', { sourceId: long.id, workers: 1 });
      await json('jobs/' + cancelled.id + '/cancel', {});
      assert.equal((await finish(cancelled.id)).status, 'cancelled');
    } finally {
      app.server.closeAllConnections();
      await app.close();
    }
  },
);
