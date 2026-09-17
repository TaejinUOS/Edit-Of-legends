const ppro = require('premierepro');
const uxp = require('uxp');
const host = require('./premiere.js').adapter(ppro);
const $ = (id) => document.getElementById(id);
let connection = null,
  source = null,
  job = null,
  timer = null,
  cancelGeneration = false,
  generating = false;
function message(t) {
  $('message').textContent = t;
}
function safe(fn) {
  return async () => {
    try {
      await fn();
    } catch (e) {
      message(e.message || String(e));
    }
  };
}
async function api(route, method = 'GET', data) {
  if (!connection) throw Error('엔진 연결 파일을 먼저 선택하세요.');
  const res = await fetch(connection.url + '/api/' + route, {
    method,
    headers: {
      Authorization: 'Bearer ' + connection.token,
      ...(data ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(data ? { body: JSON.stringify(data) } : {}),
  });
  const b = await res.json();
  if (!res.ok) throw Error(b.error || '엔진 요청 실패');
  return b;
}
const settings = () => ({
  before: Number($('before').value),
  after: Number($('after').value),
  gap: Number($('gap').value),
  types: ['kill', 'assist', 'death'].filter((t) => $(t).checked),
});
const roi = () =>
  Object.fromEntries(['x', 'y', 'width', 'height'].map((k) => [k, Number($(k).value) / 100]));
function setSettings(s = {}) {
  for (const k of ['before', 'after', 'gap'])
    $(k).value = String(s[k] ?? { before: 11, after: 7, gap: 15 }[k]);
  for (const t of ['kill', 'assist', 'death'])
    $(t).checked = (s.types ?? ['kill', 'assist', 'death']).includes(t);
}
async function refresh() {
  const jobs = await api('jobs');
  $('jobs').innerHTML = '';
  for (const j of jobs.filter((j) => j.status === 'done')) {
    const o = document.createElement('option');
    o.value = j.id;
    o.textContent = j.source.name + ' · ' + new Date(j.startedAt).toLocaleTimeString();
    $('jobs').appendChild(o);
  }
}
function render() {
  const list = $('events');
  list.innerHTML = '';
  if (!job) return;
  $('summary').textContent =
    `${job.events.length}개 이벤트 · K/D/A ${job.result?.finalKda?.join(' / ') ?? '—'} · 검토 ${job.events.filter((e) => e.review).length}개`;
  for (const e of job.events) {
    const row = document.createElement('div');
    row.className = 'event' + (e.review ? ' review' : '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = e.included;
    box.onchange = safe(async () => {
      e.included = box.checked;
      job = await api('jobs/' + job.id, 'PATCH', { events: job.events, settings: settings() });
    });
    const text = document.createElement('span');
    text.textContent = `${{ kill: '킬', assist: '어시', death: '데스' }[e.type]} · ${e.time.toFixed(1)}초${e.review ? ' · 확인 필요' : ''}`;
    row.appendChild(box);
    row.appendChild(text);
    list.appendChild(row);
  }
}
async function poll() {
  job = await api('jobs/' + job.id);
  $('progress').textContent = `${job.stage} · ${Math.round(job.progress * 100)}%`;
  if (job.status === 'running') {
    timer = setTimeout(safe(poll), 1000);
    return;
  }
  $('analyze').disabled = false;
  if (job.status === 'done') {
    render();
    await refresh();
    message(
      job.result.warnings.map((w) => w.message).join('\n') ||
        '분석 완료. 이벤트를 검토하고 새 시퀀스를 생성하세요.',
    );
  } else message(job.error || '분석 취소');
}
$('connect').onclick = safe(async () => {
  const file = await uxp.storage.localFileSystem.getFileForOpening({ types: ['json'] });
  if (!file) return;
  const c = JSON.parse(await file.read());
  if (c.url !== 'http://127.0.0.1:4317' || typeof c.token !== 'string')
    throw Error('올바른 connection.json을 선택하세요.');
  connection = c;
  const h = await api('health');
  if (h.version !== '0.1.0') throw Error('패널과 엔진 버전이 다릅니다.');
  if (!h.ffmpeg || !h.ffprobe) throw Error('FFmpeg/ffprobe를 찾을 수 없습니다.');
  $('health').textContent = '로컬 엔진 연결됨';
  await refresh();
  message('연결되었습니다.');
});
$('source').onclick = safe(async () => {
  if (job?.status === 'running' || generating) throw Error('현재 작업을 완료하거나 취소하세요.');
  source = await api('sources', 'POST', await host.selectedSource());
  job = null;
  render();
  $('source-info').textContent =
    `${source.name}\n${source.in.toFixed(2)}–${source.out.toFixed(2)}초 · ${source.width}×${source.height}`;
  message('소스를 불러왔습니다. HUD 영역을 확인한 뒤 분석하세요.');
});
$('review').onclick = safe(async () => {
  if (!connection) throw Error('먼저 엔진을 연결하세요.');
  await uxp.shell.openExternal(connection.url + '/#' + connection.token);
});
$('analyze').onclick = safe(async () => {
  if (!source) throw Error('선택 클립을 먼저 불러오세요.');
  if (generating) throw Error('시퀀스 생성 중입니다.');
  job = await api('jobs', 'POST', {
    sourceId: source.id,
    roi: roi(),
    workers: $('workers').value,
    interval: 0.5,
  });
  $('analyze').disabled = true;
  clearTimeout(timer);
  await poll();
});
$('cancel').onclick = safe(async () => {
  cancelGeneration = true;
  if (job?.status === 'running') await api('jobs/' + job.id + '/cancel', 'POST', {});
  message('취소를 요청했습니다.');
});
$('refresh').onclick = safe(refresh);
$('load-job').onclick = safe(async () => {
  if (generating || job?.status === 'running') throw Error('현재 작업 완료 후 불러오세요.');
  const id = $('jobs').value;
  if (!id) return;
  job = await api('jobs/' + id);
  source = job.source;
  setSettings(job.settings);
  for (const k of ['x', 'y', 'width', 'height']) $(k).value = String(job.options.roi[k] * 100);
  $('source-info').textContent = source.name;
  render();
  message('저장된 작업을 불러왔습니다.');
});
$('generate').onclick = safe(async () => {
  if (!job || job.status !== 'done') throw Error('완료된 작업을 불러오세요.');
  if (generating) return;
  generating = true;
  cancelGeneration = false;
  $('generate').disabled = true;
  try {
    const latest = await api('jobs/' + job.id);
    job = latest;
    const plan = await api('jobs/' + job.id + '/plan', 'POST', { settings: settings() });
    if (!plan.clips.length) throw Error('생성할 컷이 없습니다.');
    const result = await host.generate(plan, {
      isCancelled: () => cancelGeneration,
      onProgress: (stage, p) => {
        $('progress').textContent = stage + ' · ' + Math.round(p * 100) + '%';
      },
    });
    message(
      `${result.name}\n${result.clips}개 컷, 오디오 ${result.audioTracks}개 트랙을 생성하고 검증했습니다.`,
    );
  } finally {
    generating = false;
    $('generate').disabled = false;
  }
});
