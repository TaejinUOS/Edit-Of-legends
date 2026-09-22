import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  bin,
  run,
  probe,
  verifyCfr,
  frame,
  sampleFrames,
  isSupportedVideo,
} from '../engine/media.js';
import { createApp } from '../engine/server.js';

test('MP4 and MKV: real CFR media, preview, sampling and HTTP streaming', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'eol-media-'));
  const app = await createApp({ port: 0, token: 'media-test', stateDir: dir });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${app.server.address().port}`;
  try {
    assert.equal(isSupportedVideo('recording.MKV'), true);
    assert.equal(isSupportedVideo('recording.avi'), false);
    for (const [extension, fps] of [
      ['mp4', 30],
      ['mkv', 30],
      ['MKV', 60],
    ]) {
      const file = path.join(dir, `sample-${fps}.${extension}`);
      await run(bin('ffmpeg'), [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        `color=black:s=1920x1080:r=${fps}`,
        '-t',
        '1',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-bf',
        '2',
        file,
      ]);
      const source = await probe(file);
      assert.equal(source.fpsNum, fps);
      await verifyCfr(source);
      assert.equal((await frame(source, 0)).subarray(1, 4).toString(), 'PNG');
      const samples = [];
      for await (const sample of sampleFrames(source, { x: 0, y: 0, width: 0.1, height: 0.1 }, 0.5))
        samples.push(sample);
      assert.equal(samples.length, 2);
      const response = await fetch(base + '/api/sources', {
        method: 'POST',
        headers: { Authorization: 'Bearer media-test', 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: file }),
      });
      const registered = await response.json();
      assert.equal(response.status, 200, JSON.stringify(registered));
      const media = await fetch(base + '/api/media/' + registered.id, {
        headers: { Authorization: 'Bearer media-test', Range: 'bytes=0-31' },
      });
      assert.equal(media.status, 206);
      assert.equal(
        media.headers.get('content-type'),
        extension === 'mp4' ? 'video/mp4' : 'video/x-matroska',
      );
      assert.equal((await media.arrayBuffer()).byteLength, 32);
    }
    const variable = path.join(dir, 'variable.mkv');
    await run(bin('ffmpeg'), [
      '-v',
      'error',
      '-f',
      'lavfi',
      '-i',
      'color=black:s=1920x1080:r=30',
      '-t',
      '1',
      '-vf',
      "select='not(eq(n,10))'",
      '-fps_mode',
      'vfr',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      variable,
    ]);
    await assert.rejects(verifyCfr({ path: variable, fpsNum: 30, fpsDen: 1 }), /CFR/);
    for (const missing of [2, 3]) {
      const terminal = path.join(dir, `terminal-${missing}.mkv`);
      await run(bin('ffmpeg'), [
        '-v',
        'error',
        '-f',
        'lavfi',
        '-i',
        'color=black:s=1920x1080:r=60',
        '-t',
        '1',
        '-vf',
        `select='not(between(n,${59 - missing},58))'`,
        '-fps_mode',
        'vfr',
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        terminal,
      ]);
      const verification = verifyCfr({ path: terminal, fpsNum: 60, fpsDen: 1 });
      if (missing === 2) await verification;
      else await assert.rejects(verification, /CFR/);
    }
  } finally {
    app.server.closeAllConnections();
    await app.close();
    await rm(dir, { recursive: true, force: true });
  }
});
