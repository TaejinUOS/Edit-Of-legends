import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createApp, atomicJson } from '../engine/server.js';
test('loopback API enforces auth, host and origin; validates before mutations and persists edits', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eol-test-'));
  const app = await createApp({ port: 0, token: 'test-only-secret', stateDir: dir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  const request = (route, options = {}) =>
    fetch(base + route, {
      ...options,
      headers: { Authorization: 'Bearer test-only-secret', ...options.headers },
    });
  try {
    assert.equal((await fetch(base + '/api/jobs')).status, 401);
    assert.equal(
      (await request('/api/jobs', { headers: { Origin: 'https://attacker.example' } })).status,
      403,
    );
    const badHost = await new Promise((resolve, reject) => {
      const r = http.get(base + '/api/jobs', { headers: { Host: 'attacker.example' } }, (res) => {
        res.resume();
        resolve(res.statusCode);
      });
      r.on('error', reject);
    });
    assert.equal(badHost, 403);
    assert.equal((await request('/api/jobs')).status, 200);
    assert.equal((await fetch(base + '/engine/server.js')).status, 404);
    const job = {
      id: 'test-job',
      status: 'done',
      source: { in: 0, out: 200, fpsNum: 60, fpsDen: 1 },
      events: [{ id: '1', type: 'kill', time: 50, amount: 1, included: true }],
    };
    app.jobs.set(job.id, job);
    const before = JSON.stringify(job);
    const bad = await request('/api/jobs/test-job', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{ id: '1', type: 'kill', time: 70 }],
        settings: { before: -1 },
      }),
    });
    assert.equal(bad.status, 400);
    assert.equal(JSON.stringify(job), before);
    const good = await request('/api/jobs/test-job', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        events: [{ id: '1', type: 'assist', time: 70 }],
        settings: { before: 11, after: 7, gap: 15 },
      }),
    });
    assert.equal(good.status, 200);
    const saved = JSON.parse(await readFile(path.join(dir, 'jobs', 'test-job.json')));
    assert.equal(saved.events[0].type, 'assist');
    await atomicJson(path.join(dir, 'atomic.json'), { hello: '한글' });
    assert.equal(JSON.parse(await readFile(path.join(dir, 'atomic.json'))).hello, '한글');
  } finally {
    app.server.closeAllConnections();
    await app.close();
  }
});
