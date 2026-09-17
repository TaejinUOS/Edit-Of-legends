const $ = (id) => document.getElementById(id);
const defaults = { x: 0.867, y: 0.001, width: 0.039, height: 0.022 };
let token = location.hash.slice(1) || sessionStorage.getItem('eol-token') || '';
if (token) {
  sessionStorage.setItem('eol-token', token);
  history.replaceState(null, '', location.pathname);
}
let source = null,
  job = null,
  plan = null,
  roi = { ...defaults },
  poll = null,
  saveTimer = null,
  saveQueue = Promise.resolve(),
  dirty = 0;
const labels = { kill: '킬', assist: '어시스트', death: '데스' };
const clock = (t) =>
  `${String(Math.floor(t / 60)).padStart(2, '0')}:${(t % 60).toFixed(1).padStart(4, '0')}`;
function notice(message = '') {
  $('notice').textContent = message;
  $('notice').hidden = !message;
}
async function api(route, method = 'GET', value) {
  const r = await fetch('/api/' + route, {
    method,
    headers: {
      Authorization: 'Bearer ' + token,
      ...(value ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(value ? { body: JSON.stringify(value) } : {}),
  });
  const b = await r.json();
  if (!r.ok) throw Error(b.error || '요청 실패');
  return b;
}
function guarded(fn) {
  return async (...args) => {
    try {
      await fn(...args);
    } catch (e) {
      notice(e.message);
    }
  };
}
function settings() {
  return {
    before: +$('before').value,
    after: +$('after').value,
    gap: +$('gap').value,
    types: [...document.querySelectorAll('[name=type]:checked')].map((e) => e.value),
  };
}
function setSettings(s = {}) {
  for (const k of ['before', 'after', 'gap'])
    $(k).value = s[k] ?? { before: 11, after: 7, gap: 15 }[k];
  document
    .querySelectorAll('[name=type]')
    .forEach((e) => (e.checked = (s.types ?? Object.keys(labels)).includes(e.value)));
}
function updateRoi() {
  for (const k of Object.keys(roi)) {
    $('roi-' + k).value = +(roi[k] * 100).toFixed(3);
  }
  const b = $('roi-box');
  b.style.left = roi.x * 100 + '%';
  b.style.top = roi.y * 100 + '%';
  b.style.width = roi.width * 100 + '%';
  b.style.height = roi.height * 100 + '%';
}
function setSource(s) {
  source = s;
  $('source-name').textContent = s.name;
  $('source-meta').textContent =
    `${s.width} × ${s.height} · ${s.fpsNum / s.fpsDen}fps · ${clock(s.out - s.in)} · 오디오 ${s.audio.length}개`;
  $('video').src = `/api/media/${s.id}?access=${encodeURIComponent(token)}`;
  $('video').hidden = false;
  $('empty-view').hidden = true;
  $('roi-open').disabled = false;
  $('analyze').disabled = false;
  $('path').value = s.path;
  $('source-in').value = s.in;
  $('source-out').value = s.out;
  $('video').onloadedmetadata = () => {
    $('video').currentTime = s.in;
  };
}
async function loadSource(file) {
  if (job?.status === 'running') throw Error('분석을 취소한 뒤 소스를 변경하세요.');
  await flushSave();
  notice();
  const s = await api('sources', 'POST', {
    path: file,
    in: +$('source-in').value,
    ...($('source-out').value ? { out: +$('source-out').value } : {}),
  });
  setSource(s);
  job = null;
  plan = null;
  renderEvents();
  renderPlan();
  $('roi-editor').hidden = true;
  $('progress-area').hidden = true;
  $('add-event').disabled = true;
}
function seek(time) {
  $('video').currentTime = time;
  $('video')
    .play()
    .catch(() => {});
}
function renderEvents() {
  const list = $('event-list');
  list.replaceChildren();
  $('event-count').textContent = job?.events?.length ?? 0;
  if (!job?.events?.length) {
    const e = document.createElement('div');
    e.className = 'empty-list';
    e.textContent =
      job?.status === 'done'
        ? '확정된 이벤트가 없습니다. HUD 판독 결과를 확인하거나 이벤트를 추가하세요.'
        : '아직 분석한 장면이 없습니다.';
    list.append(e);
    return;
  }
  job.events.forEach((event, index) => {
    const row = document.createElement('div');
    row.className = 'event-row' + (event.review ? ' needs-review' : '');
    const check = document.createElement('input');
    check.type = 'checkbox';
    check.checked = event.included;
    check.setAttribute('aria-label', `${index + 1}번 이벤트 포함`);
    check.onchange = () => {
      event.included = check.checked;
      scheduleSave();
    };
    const type = document.createElement('select');
    type.setAttribute('aria-label', `${index + 1}번 이벤트 유형`);
    for (const [v, l] of Object.entries(labels)) {
      const o = new Option(l, v);
      type.add(o);
    }
    type.value = event.type;
    type.className = event.type;
    type.onchange = () => {
      event.type = type.value;
      type.className = type.value;
      event.manual = true;
      scheduleSave();
    };
    const time = document.createElement('input');
    time.type = 'number';
    time.step = String(1 / (source.fpsNum / source.fpsDen));
    time.min = source.in;
    time.max = source.out;
    time.value = event.time;
    time.setAttribute('aria-label', `${index + 1}번 이벤트 시각 (초)`);
    time.onchange = () => {
      event.time = +time.value;
      event.manual = true;
      scheduleSave();
    };
    const reason = document.createElement('span');
    reason.className = 'reason';
    reason.textContent = event.review
      ? event.reason || '검토 필요'
      : `+${event.amount ?? 1} · ${clock(event.time)}`;
    const btn = document.createElement('button');
    btn.className = 'seek';
    btn.textContent = '▶';
    btn.setAttribute('aria-label', `${clock(event.time)} 재생`);
    btn.onclick = () => seek(Math.max(source.in, event.time - 3));
    row.append(check, type, time, reason, btn);
    list.append(row);
  });
}
function renderPlan() {
  const clips = plan?.clips ?? [];
  $('cut-count').textContent = plan ? clips.length : '—';
  $('cut-duration').textContent = plan ? clock(plan.duration) : '—';
  $('export').disabled = !clips.length;
  const timeline = $('timeline'),
    list = $('clip-list');
  timeline.replaceChildren();
  list.replaceChildren();
  for (const [index, c] of clips.entries()) {
    const bar = document.createElement('i');
    bar.style.flex = String(c.outFrame - c.inFrame);
    bar.style.background = `var(--${c.type})`;
    bar.title = `${labels[c.type]} ${clock(c.in)}–${clock(c.out)}`;
    timeline.append(bar);
    const row = document.createElement('div');
    row.className = 'clip-row';
    const type = document.createElement('span');
    type.className = `clip-type ${c.type}`;
    type.textContent = `V${c.track + 1} · ${labels[c.type]}`;
    const start = document.createElement('input'),
      end = document.createElement('input');
    for (const [input, k, label] of [
      [start, 'in', '시작'],
      [end, 'out', '끝'],
    ]) {
      input.type = 'number';
      input.step = '0.1';
      input.min = source.in;
      input.max = source.out;
      input.value = +c[k].toFixed(3);
      input.setAttribute('aria-label', `${index + 1}번 컷 ${label} (초)`);
      input.onchange = guarded(async () => {
        await flushSave();
        const overrides = {
          ...(job.overrides ?? {}),
          [c.key]: { in: +start.value, out: +end.value },
        };
        plan = await api(`jobs/${job.id}/plan`, 'POST', { settings: settings(), overrides });
        job.overrides = overrides;
        renderPlan();
      });
    }
    const info = document.createElement('span');
    info.className = 'clip-info mono';
    info.textContent = `${(c.out - c.in).toFixed(1)}초${c.manual ? ' · 수정됨' : c.long ? ' · 긴 교전' : ''}`;
    const btn = document.createElement('button');
    btn.className = 'seek';
    btn.textContent = '▶';
    btn.onclick = () => seek(c.in);
    row.append(type, start, end, info, btn);
    list.append(row);
  }
  if (!clips.length) {
    const e = document.createElement('div');
    e.className = 'empty-list';
    e.textContent = '포함된 이벤트로 생성할 컷이 없습니다.';
    list.append(e);
  }
}
async function refreshPlan() {
  if (job?.status !== 'done') return;
  plan = await api(`jobs/${job.id}/plan`, 'POST', { settings: settings() });
  renderPlan();
}
function scheduleSave() {
  dirty++;
  $('save-state').textContent = '저장 대기…';
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => guarded(flushSave)(), 450);
}
async function flushSave() {
  clearTimeout(saveTimer);
  if (!job || job.status !== 'done' || !dirty) return saveQueue;
  const snapshot = { id: job.id, events: structuredClone(job.events), settings: settings() },
    revision = dirty;
  saveQueue = saveQueue
    .catch(() => {})
    .then(async () => {
      try {
        const saved = await api(`jobs/${snapshot.id}`, 'PATCH', snapshot);
        if (job?.id === snapshot.id) {
          job.overrides = saved.overrides ?? {};
          if (dirty === revision) dirty = 0;
          await refreshPlan();
          $('save-state').textContent = dirty ? '저장 대기…' : '저장됨';
        }
      } catch (e) {
        $('save-state').textContent = '저장 실패';
        throw e;
      }
    });
  return saveQueue;
}
function showJob(j) {
  job = j;
  dirty = 0;
  setSource(j.source);
  roi = { ...j.options.roi };
  updateRoi();
  setSettings(j.settings);
  $('progress-area').hidden = false;
  renderProgress();
  renderEvents();
  $('add-event').disabled = j.status !== 'done';
  $('result-description').textContent = j.result
    ? `K/D/A ${j.result.finalKda?.join(' / ')} · 판독률 ${(j.result.readableRatio * 100).toFixed(1)}% · 검토 필요 ${j.events.filter((e) => e.review).length}개`
    : '';
}
function renderProgress() {
  const running = job?.status === 'running';
  $('analyze').disabled = running || !source;
  $('cancel').hidden = !running;
  $('stage').textContent = job?.stage ?? '';
  $('progress').value = job?.progress ?? 0;
  $('percent').textContent = Math.round((job?.progress ?? 0) * 100) + '%';
  const seconds = (job?.elapsedMs ?? Date.now() - (job?.startedAt ?? Date.now())) / 1000;
  const remaining = job?.progress > 0.03 && running ? seconds * (1 / job.progress - 1) : null;
  $('elapsed').textContent =
    `${clock(seconds)} 경과${remaining !== null ? ' · 약 ' + clock(remaining) + ' 남음' : ''}${job?.cached ? ' · 캐시 사용' : ''}`;
}
async function refreshJobs() {
  const jobs = await api('jobs');
  const select = $('recent-jobs');
  select.replaceChildren(new Option('저장된 작업 선택', ''));
  for (const j of jobs)
    select.add(
      new Option(
        `${j.source.name} · ${j.status === 'done' ? '완료' : j.stage} · ${new Date(j.startedAt).toLocaleTimeString('ko-KR')}`,
        j.id,
      ),
    );
}
async function pollJob() {
  if (!job) return;
  const j = await api(`jobs/${job.id}`);
  job = j;
  renderProgress();
  if (j.status === 'running') {
    poll = setTimeout(() => guarded(pollJob)(), 900);
    return;
  }
  renderEvents();
  $('add-event').disabled = j.status !== 'done';
  if (j.status === 'done') {
    const r = j.result;
    $('result-description').textContent =
      `K/D/A ${r.finalKda?.join(' / ')} · 판독률 ${(r.readableRatio * 100).toFixed(1)}% · 검토 필요 ${j.events.filter((e) => e.review).length}개`;
    await refreshPlan();
    if (r.warnings.length)
      notice(r.warnings.map((w) => `${clock(w.time)} ${w.message}`).join('\n'));
    else notice('분석이 완료되었습니다. 장면을 검토한 뒤 Premiere 패널에서 시퀀스를 생성하세요.');
  } else notice(j.error || '작업이 취소되었습니다.');
  await refreshJobs();
}
async function initialize() {
  const h = await api('health');
  $('engine-state').textContent = h.ffmpeg && h.ffprobe ? '로컬 엔진 연결됨' : 'FFmpeg 설치 필요';
  const files = await api('files');
  $('files').replaceChildren(new Option('로컬 녹화본 선택', ''));
  for (const f of files) $('files').add(new Option(f.name, f.path));
  if (files.length === 1) $('files').value = files[0].path;
  await refreshJobs();
  updateRoi();
}
$('load-file').onclick = guarded(() => loadSource($('files').value));
$('load-path').onclick = guarded(() => loadSource($('path').value));
$('connection-button').onclick = () => $('connection-file').click();
$('connection-file').onchange = guarded(async () => {
  const c = JSON.parse(await $('connection-file').files[0].text());
  if (c.url !== 'http://127.0.0.1:4317') throw Error('연결 주소가 다릅니다.');
  token = c.token;
  sessionStorage.setItem('eol-token', token);
  await initialize();
  notice();
});
$('video').ontimeupdate = () => {
  $('time-label').textContent = clock($('video').currentTime);
};
$('roi-open').onclick = guarded(async () => {
  const time = Math.min(
    source.out - 1 / source.fpsNum,
    Math.max(source.in, $('video').currentTime),
  );
  $('video').pause();
  const r = await api('preview', 'POST', { sourceId: source.id, time });
  $('roi-image').src = r.image;
  $('roi-editor').hidden = false;
  $('roi-editor').dataset.time = time;
  updateRoi();
});
$('roi-close').onclick = () => ($('roi-editor').hidden = true);
$('roi-reset').onclick = () => {
  roi = { ...defaults };
  updateRoi();
};
for (const k of Object.keys(roi))
  $('roi-' + k).onchange = () => {
    roi[k] = +$('roi-' + k).value / 100;
    updateRoi();
  };
let drag = null;
const wrap = $('roi-image-wrap');
function point(e) {
  const r = wrap.getBoundingClientRect();
  return {
    x: Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)),
    y: Math.max(0, Math.min(1, (e.clientY - r.top) / r.height)),
  };
}
wrap.onpointerdown = (e) => {
  drag = point(e);
  wrap.setPointerCapture(e.pointerId);
};
wrap.onpointermove = (e) => {
  if (!drag) return;
  const p = point(e);
  roi = {
    x: Math.min(p.x, drag.x),
    y: Math.min(p.y, drag.y),
    width: Math.abs(p.x - drag.x),
    height: Math.abs(p.y - drag.y),
  };
  updateRoi();
};
wrap.onpointerup = () => (drag = null);
$('ocr-test').onclick = guarded(async () => {
  $('ocr-result').textContent = '판독 중…';
  const r = await api('ocr', 'POST', {
    sourceId: source.id,
    time: +$('roi-editor').dataset.time,
    roi,
  });
  $('ocr-result').textContent = r.kda
    ? `${r.kda.join(' / ')} · 신뢰도 ${r.confidence}%`
    : '판독 실패 — 영역을 조정하세요';
});
$('analyze').onclick = guarded(async () => {
  await flushSave();
  notice();
  job = await api('jobs', 'POST', {
    sourceId: source.id,
    roi,
    workers: $('workers').value,
    interval: 0.5,
  });
  plan = null;
  renderEvents();
  renderPlan();
  $('progress-area').hidden = false;
  $('add-event').disabled = true;
  clearTimeout(poll);
  await pollJob();
});
$('cancel').onclick = guarded(async () => {
  await api(`jobs/${job.id}/cancel`, 'POST', {});
  $('stage').textContent = '취소 중…';
});
for (const id of ['before', 'after', 'gap'])
  $(id).onchange = () => {
    document.querySelector('.context-bar span:first-child').textContent =
      `이전 ${$('before').value}초`;
    document.querySelector('.context-bar span:last-child').textContent =
      `이후 ${$('after').value}초`;
    scheduleSave();
  };
document.querySelectorAll('[name=type]').forEach((e) => (e.onchange = scheduleSave));
$('add-event').onclick = () => {
  job.events.push({
    id: 'manual-' + crypto.randomUUID(),
    type: 'kill',
    time: Math.max(source.in, Math.min(source.out, $('video').currentTime)),
    amount: 1,
    included: true,
    manual: true,
  });
  renderEvents();
  scheduleSave();
};
document.querySelectorAll('[data-tab]').forEach(
  (el) =>
    (el.onclick = () => {
      document
        .querySelectorAll('[data-tab]')
        .forEach((t) => t.classList.toggle('active', t === el));
      $('event-list').hidden = el.dataset.tab !== 'events';
      $('clip-list').hidden = el.dataset.tab !== 'clips';
    }),
);
$('export').onclick = guarded(async () => {
  await flushSave();
  await refreshPlan();
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' }),
    url = URL.createObjectURL(blob),
    a = document.createElement('a');
  a.href = url;
  a.download = 'EditOfLegends-plan.json';
  a.click();
  URL.revokeObjectURL(url);
  notice('편집 계획을 저장했습니다. Premiere 패널에서도 같은 작업을 바로 불러올 수 있습니다.');
});
$('restore').onclick = guarded(async () => {
  if (job?.status === 'running') throw Error('분석을 취소한 뒤 다른 작업을 불러오세요.');
  await flushSave();
  const id = $('recent-jobs').value;
  if (!id) return;
  clearTimeout(poll);
  showJob(await api('jobs/' + id));
  if (job.status === 'running') await pollJob();
  else {
    await refreshPlan();
    notice(
      job.error ||
        job.result?.warnings?.map((w) => `${clock(w.time)} ${w.message}`).join('\n') ||
        '저장된 작업을 불러왔습니다.',
    );
  }
});
window.addEventListener('beforeunload', (e) => {
  if (dirty) {
    e.preventDefault();
    e.returnValue = '';
  }
});
guarded(initialize)();
