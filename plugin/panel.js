const ppro = require('premierepro');
const { entrypoints, shell, storage } = require('uxp');
const host = require('./premiere.js').adapter(ppro);
const $ = (id) => document.getElementById(id);
const CONNECTION_FILE_KEY = 'editoflegends.connection-file-token';
const ENGINE_TOKEN_KEY = 'editoflegends.engine-token';
const ENGINE_URL = 'http://localhost:4317';
const ENGINE_VERSION = '0.2.3';
const ENGINE_START_URL = 'editoflegends://start';

let connection = null;
let source = null;
let sources = [];
let job = null;
let batchJobs = [];
let batchRunning = false;
let batchCancelled = false;
let pollTimer = null;
let cancelGeneration = false;
let generating = false;
let autoConnectStarted = false;

function showMessage(text, error = false) {
  $('message').textContent = text;
  $('message').classList.toggle('error', error);
}

function setHealth(text, state = 'offline') {
  $('health').className = 'status ' + state;
  $('health').innerHTML = '<i></i>' + text;
}

function setAdvancedSettings(expanded) {
  $('settings-toggle').setAttribute('aria-expanded', String(expanded));
  $('advanced-settings').classList.toggle('hidden', !expanded);
  $('settings-arrow').textContent = expanded ? '▾' : '▸';
}

function setProgress(stage, value) {
  const percent = Math.max(0, Math.min(100, Math.round(value * 100)));
  $('progress-wrap').classList.remove('hidden');
  $('progress-label').textContent = stage || '처리 중';
  $('progress-percent').textContent = percent + '%';
  $('progress-bar').style.width = percent + '%';
}

function clearProgress() {
  $('progress-wrap').classList.add('hidden');
  $('progress-label').textContent = '준비 중';
  $('progress-percent').textContent = '0%';
  $('progress-bar').style.width = '0%';
}

function isAnalyzing() {
  return batchRunning || job?.status === 'running';
}

function updateControls() {
  const connected = Boolean(connection);
  const analyzing = isAnalyzing();
  const busy = analyzing || generating;
  $('connect').disabled = busy;
  $('connection-file').disabled = busy;
  $('source').disabled = !connected || busy;
  for (const id of [
    'flash-enabled',
    'flash-slot',
    'flash-x',
    'flash-y',
    'flash-width',
    'flash-height',
  ])
    $(id).disabled = busy;
  $('review').disabled = !connected;
  $('clock-test').disabled = !connected || !source || busy;
  $('flash-test').disabled = !connected || !source || busy;
  $('analyze').disabled = !connected || !source || busy;
  $('cancel').disabled = !busy;
  $('refresh').disabled = !connected || busy;
  $('load-job').disabled = !connected || busy || !$('jobs').value;
  $('generate').disabled = !connected || (job?.status !== 'done' && !batchJobs.length) || busy;
}

function fail(error) {
  console.error(error);
  if (!connection) setHealth('연결 실패', 'error');
  showMessage(error?.message || String(error), true);
}

function safe(fn) {
  return async () => {
    try {
      await fn();
    } catch (error) {
      fail(error);
    } finally {
      updateControls();
    }
  };
}

async function request(activeConnection, route, method = 'GET', data) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15000);
  let response;
  try {
    response = await fetch(activeConnection.url + '/api/' + route, {
      method,
      signal: controller.signal,
      headers: {
        Authorization: 'Bearer ' + activeConnection.token,
        ...(data === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
  } catch (error) {
    if (error?.name === 'AbortError') throw Error('엔진 응답 시간이 초과되었습니다.');
    const detail = error?.message ? ` (${error.message})` : '';
    throw Error(`로컬 엔진에 연결할 수 없습니다${detail}`);
  } finally {
    clearTimeout(timeout);
  }
  const text = await response.text();
  let body;
  try {
    body = text ? JSON.parse(text) : {};
  } catch {
    throw Error('엔진에서 올바르지 않은 응답을 받았습니다.');
  }
  if (!response.ok) {
    const error = Error(body.error || `엔진 요청 실패 (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

async function api(route, method = 'GET', data) {
  if (!connection) throw Error('분석 엔진을 먼저 연결하세요.');
  try {
    return await request(connection, route, method, data);
  } catch (error) {
    if (error.status !== 401) throw error;
    const file = await rememberedConnectionFile();
    if (!file) throw error;
    connection = await readConnectionFile(file);
    await verifyConnection(connection);
    return request(connection, route, method, data);
  }
}

function validateConnection(candidate) {
  if (candidate?.url !== ENGINE_URL || typeof candidate.token !== 'string' || !candidate.token)
    throw Error('이 프로젝트의 .eol/connection.json을 선택하세요.');
  return candidate;
}

async function readConnectionFile(file) {
  try {
    return validateConnection(JSON.parse(await file.read()));
  } catch (error) {
    if (error.message?.includes('.eol/connection.json')) throw error;
    throw Error('연결 파일을 읽을 수 없습니다.');
  }
}

async function verifyConnection(candidate) {
  const health = await request(candidate, 'health');
  if (health.version !== ENGINE_VERSION) throw Error('패널과 엔진 버전이 다릅니다.');
  if (!health.ffmpeg || !health.ffprobe) throw Error('FFmpeg/ffprobe를 찾을 수 없습니다.');
}

function companionConnection() {
  let token = localStorage.getItem(ENGINE_TOKEN_KEY);
  if (!/^[a-f0-9]{64}$/i.test(token || '')) {
    const bytes = new Uint8Array(32);
    crypto.getRandomValues(bytes);
    token = Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('');
    localStorage.setItem(ENGINE_TOKEN_KEY, token);
  }
  return { url: ENGINE_URL, token };
}

function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function startCompanion(candidate) {
  setHealth('엔진 시작 중', 'offline');
  showMessage('EditOfLegends 분석 엔진을 시작하고 있습니다.');
  const result = await shell.openExternal(
    ENGINE_START_URL + '?token=' + encodeURIComponent(candidate.token),
    'EditOfLegends가 로컬 분석 엔진을 시작합니다. 영상은 이 컴퓨터 안에서만 처리됩니다.',
  );
  if (result) throw Error('분석 엔진을 시작하지 못했습니다. ' + result);
  let lastError;
  for (let attempt = 0; attempt < 30; attempt++) {
    await wait(500);
    try {
      await verifyConnection(candidate);
      return;
    } catch (error) {
      lastError = error;
      if (error.status === 401)
        throw Error(
          '다른 인증 정보로 실행 중인 엔진이 있습니다. 기존 엔진을 종료한 뒤 다시 시도하세요.',
        );
    }
  }
  throw Error(`분석 엔진이 준비되지 않았습니다. ${lastError?.message || ''}`.trim());
}

async function connectCompanion({ automatic = false } = {}) {
  const candidate = companionConnection();
  setHealth('연결 확인 중', 'offline');
  try {
    await verifyConnection(candidate);
  } catch (error) {
    if (error.status === 401) throw error;
    await startCompanion(candidate);
  }
  connection = candidate;
  setHealth('엔진 연결됨', 'online');
  await refreshJobs();
  showMessage(
    automatic
      ? '로컬 분석 엔진을 자동으로 시작하고 연결했습니다.'
      : '로컬 분석 엔진에 연결했습니다.',
  );
}

async function rememberedConnectionFile() {
  const token = localStorage.getItem(CONNECTION_FILE_KEY);
  if (!token) return null;
  try {
    return await storage.localFileSystem.getEntryForPersistentToken(token);
  } catch {
    localStorage.removeItem(CONNECTION_FILE_KEY);
    return null;
  }
}

async function connectFile(file, { remember = false, automatic = false } = {}) {
  const candidate = await readConnectionFile(file);
  setHealth('연결 확인 중', 'offline');
  await verifyConnection(candidate);
  connection = candidate;
  setHealth('엔진 연결됨', 'online');
  if (remember) {
    const token = await storage.localFileSystem.createPersistentToken(file);
    localStorage.setItem(CONNECTION_FILE_KEY, token);
  }
  await refreshJobs();
  showMessage(
    automatic
      ? '저장된 연결 파일로 로컬 엔진에 자동 연결했습니다.'
      : '로컬 분석 엔진에 연결했습니다. 다음부터 자동으로 연결됩니다.',
  );
}

async function autoConnect() {
  if (autoConnectStarted || connection) return;
  autoConnectStarted = true;
  try {
    await connectCompanion({ automatic: true });
  } catch (error) {
    const file = await rememberedConnectionFile();
    if (file) {
      try {
        await connectFile(file, { automatic: true });
        return;
      } catch {
        /* Fall through to the companion error and show the developer fallback. */
      }
    }
    connection = null;
    setAdvancedSettings(true);
    setHealth('자동 연결 실패', 'error');
    showMessage(`${error.message}\n동반 앱을 설치하거나 개발용 연결 파일을 선택하세요.`, true);
  } finally {
    updateControls();
  }
}

function readSettings() {
  const values = Object.fromEntries(
    ['before', 'after', 'gap'].map((key) => [key, Number($(key).value)]),
  );
  if (!Number.isFinite(values.before) || values.before < 0 || values.before > 120)
    throw Error('이전 시간은 0–120초로 입력하세요.');
  if (!Number.isFinite(values.after) || values.after < 0 || values.after > 120)
    throw Error('이후 시간은 0–120초로 입력하세요.');
  if (!Number.isFinite(values.gap) || values.gap < 0 || values.gap > 60)
    throw Error('동시 판정은 0–60초로 입력하세요.');
  values.types = ['kill', 'assist', 'death', 'flash'].filter((type) => $(type).checked);
  return values;
}

function readRoi(prefix = '', label = 'HUD') {
  const values = Object.fromEntries(
    ['x', 'y', 'width', 'height'].map((key) => [
      key,
      Number($((prefix ? prefix + '-' : '') + key).value) / 100,
    ]),
  );
  if (
    Object.values(values).some((value) => !Number.isFinite(value)) ||
    values.x < 0 ||
    values.y < 0 ||
    values.width <= 0 ||
    values.height <= 0 ||
    values.x + values.width > 1 ||
    values.y + values.height > 1
  )
    throw Error(`${label} 영역이 화면 밖으로 나가지 않도록 입력하세요.`);
  return values;
}

function setSettings(settings = {}) {
  const defaults = { before: 11, after: 7, gap: 15 };
  for (const key of Object.keys(defaults)) $(key).value = String(settings[key] ?? defaults[key]);
  for (const type of ['kill', 'assist', 'death', 'flash'])
    $(type).checked = (settings.types ?? ['kill', 'assist', 'death', 'flash']).includes(type);
}

function applySourceKdaDefault() {
  const roi = readRoi();
  const isPreset =
    [86, 86.7].some((x) => Math.abs(roi.x * 100 - x) < 1e-8) &&
    Math.abs(roi.y - 0.001) < 1e-8 &&
    Math.abs(roi.width - 0.039) < 1e-8 &&
    Math.abs(roi.height - 0.022) < 1e-8;
  if (!isPreset) return;
  const preset = source.defaultRoi ?? {
    x: 0.867,
    y: 0.001,
    width: 0.039,
    height: 0.022,
  };
  for (const key of ['x', 'y', 'width', 'height']) $(key).value = String(preset[key] * 100);
}

function sourceFlashRoi() {
  const slot = $('flash-slot').value;
  return (
    source?.defaultFlashRois?.[slot] ?? {
      x: slot === 'D' ? 0.516 : 0.535,
      y: 0.916,
      width: 0.015,
      height: 0.026,
    }
  );
}

function setFlashRoi(roi) {
  for (const key of ['x', 'y', 'width', 'height']) $('flash-' + key).value = String(roi[key] * 100);
}

function applySourceFlashDefault() {
  const roi = readRoi('flash', '점멸 HUD');
  if (
    [0.509, 0.516, 0.528, 0.535].some((x) => Math.abs(x - roi.x) < 1e-8) &&
    [0.915, 0.916].some((y) => Math.abs(y - roi.y) < 1e-8) &&
    Math.abs(roi.width - 0.015) < 1e-8 &&
    Math.abs(roi.height - 0.026) < 1e-8
  )
    setFlashRoi(sourceFlashRoi());
}

function setSourceInfo(value) {
  $('source-info').classList.toggle('empty', !value);
  $('source-info').textContent = value || '타임라인에서 영상 클립을 하나 이상 선택하세요.';
}

function describeSources(items) {
  return items.map((item, index) =>
    `${items.length > 1 ? `${index + 1}. ` : ''}${item.name} · ${item.in.toFixed(2)}–${item.out.toFixed(2)}초 · ${item.width}×${item.height} · ${item.fpsNum / item.fpsDen}fps`,
  ).join('\n');
}

async function refreshJobs(preferredId = job?.id) {
  const jobs = await api('jobs');
  const completed = jobs.filter((item) => item.status === 'done');
  $('jobs').innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = completed.length ? '완료된 작업 선택' : '완료된 작업 없음';
  $('jobs').appendChild(placeholder);
  for (const item of completed) {
    const option = document.createElement('option');
    option.value = item.id;
    option.textContent = `${item.source.name} · ${item.source.in.toFixed(1)}–${item.source.out.toFixed(1)}초 · ${new Date(item.startedAt).toLocaleTimeString()}`;
    $('jobs').appendChild(option);
  }
  if (preferredId && completed.some((item) => item.id === preferredId))
    $('jobs').value = preferredId;
  updateControls();
}

function renderEvents() {
  const list = $('events');
  list.innerHTML = '';
  if (!job) {
    $('summary').textContent = '분석 결과를 불러오면 이벤트가 여기에 표시됩니다.';
    return;
  }
  const events = job.events ?? [];
  const included = events.filter((event) => event.included).length;
  const openingStatus = job.result?.openingWindow
    ? '인게임 0:50–3:30 포함'
    : '인게임 시계 재분석 필요';
  $('summary').textContent =
    `${events.length}개 이벤트 · 포함 ${included}개 · K/D/A ${job.result?.finalKda?.join(' / ') ?? '—'} · 검토 ${events.filter((event) => event.review).length}개 · ${openingStatus}`;
  if (job.result?.warnings?.length)
    $('summary').textContent +=
      '\n' + job.result.warnings.map((warning) => warning.message).join('\n');
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-events';
    empty.textContent = job.result?.openingWindow
      ? '감지된 이벤트가 없습니다. 인게임 0:50–3:30 클립은 생성됩니다.'
      : '감지된 이벤트가 없습니다. 인게임 시계를 다시 분석하세요.';
    list.appendChild(empty);
    return;
  }
  const labels = { kill: '킬', assist: '어시', death: '데스', flash: '점멸' };
  const tracks = { kill: 'V1', assist: 'V2', death: 'V3', flash: 'V4' };
  for (const event of events) {
    const row = document.createElement('label');
    row.className = 'event' + (event.review ? ' review' : '');
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = event.included;
    box.onchange = safe(async () => {
      event.included = box.checked;
      job = await api('jobs/' + job.id, 'PATCH', {
        events: job.events,
        settings: readSettings(),
      });
      renderEvents();
      showMessage('이벤트 포함 설정을 저장했습니다.');
    });
    const copy = document.createElement('span');
    copy.className = 'event-copy';
    copy.textContent = `${labels[event.type] ?? event.type} · ${event.time.toFixed(1)}초`;
    const meta = document.createElement('small');
    meta.textContent = `${tracks[event.type] ?? ''}${event.review ? ' · 확인 필요' : ''}`;
    row.appendChild(box);
    row.appendChild(copy);
    row.appendChild(meta);
    list.appendChild(row);
  }
}

async function pollJob() {
  job = await api('jobs/' + job.id);
  setProgress(job.stage, job.progress);
  updateControls();
  if (job.status === 'running') {
    pollTimer = setTimeout(() => {
      pollJob().catch((error) => {
        fail(error);
        if (job) job.status = 'error';
        updateControls();
      });
    }, 1000);
    return;
  }
  if (job.status === 'done') {
    setProgress(job.cached ? '분석 완료 · 캐시 사용' : '분석 완료', 1);
    renderEvents();
    await refreshJobs(job.id);
    const warnings = (job.result?.warnings ?? []).map((warning) => warning.message).join('\n');
    showMessage(
      warnings ||
        (job.cached
          ? '저장된 분석 캐시를 사용했습니다. 이벤트를 검토하고 새 시퀀스를 생성하세요.'
          : '분석 완료. 이벤트를 검토하고 새 시퀀스를 생성하세요.'),
    );
  } else {
    clearProgress();
    showMessage(job.error || '분석이 취소되었습니다.', job.status === 'error');
  }
  updateControls();
}

$('connect').onclick = safe(async () => {
  connection = null;
  await connectCompanion();
});

$('connection-file').onclick = safe(async () => {
  const file = await storage.localFileSystem.getFileForOpening({ types: ['json'] });
  if (!file) return;
  await connectFile(file, { remember: true });
});

$('source').onclick = safe(async () => {
  if (isAnalyzing() || generating) throw Error('현재 작업을 완료하거나 취소하세요.');
  const selected = await host.selectedSources();
  const loaded = [];
  for (const item of selected) loaded.push(await api('sources', 'POST', item));
  sources = loaded;
  source = sources[0];
  batchJobs = [];
  applySourceKdaDefault();
  applySourceFlashDefault();
  $('clock-time').value = String(Math.min(source.out - 1 / source.fpsNum, source.in + 120));
  $('flash-time').value = String(Math.min(source.out - 1 / source.fpsNum, source.in + 180));
  job = null;
  renderEvents();
  clearProgress();
  setSourceInfo(describeSources(sources));
  showMessage(`${sources.length}개 소스를 불러왔습니다. HUD 영역을 확인한 뒤 분석하세요.`);
});

$('review').onclick = safe(async () => {
  if (!connection) throw Error('먼저 엔진을 연결하세요.');
  const result = await shell.openExternal(
    connection.url + '/#' + encodeURIComponent(connection.token),
    'EditOfLegends 분석 결과와 HUD 영역을 브라우저에서 검토합니다.',
  );
  if (result) throw Error('검토 화면을 열지 못했습니다: ' + result);
});

$('clock-test').onclick = safe(async () => {
  if (!source) throw Error('선택 클립을 먼저 불러오세요.');
  const result = await api('ocr', 'POST', {
    sourceId: source.id,
    time: Number($('clock-time').value),
    roi: readRoi('clock', '시계 HUD'),
    kind: 'clock',
  });
  showMessage(
    result.clockSeconds === null
      ? '인게임 시계를 읽지 못했습니다. 시계 영역이나 확인할 시각을 조정하세요.'
      : `인게임 시계 판독: ${result.text} (${result.confidence.toFixed(0)}%)`,
  );
});

function readFlashOptions() {
  return {
    enabled: $('flash-enabled').checked,
    slot: $('flash-slot').value,
    roi: readRoi('flash', '점멸 HUD'),
  };
}

$('flash-slot').onchange = () => {
  setFlashRoi(sourceFlashRoi());
};

$('flash-test').onclick = safe(async () => {
  const result = await api('ocr', 'POST', {
    sourceId: source.id,
    kind: 'flash',
    time: Number($('flash-time').value),
    flash: readFlashOptions(),
  });
  showMessage(
    result.state === 'ready'
      ? '점멸 사용 가능 상태입니다.'
      : result.state === 'cooldown'
        ? `재사용 대기시간: ${result.cooldown}초`
        : '점멸을 읽지 못했습니다. 슬롯, HUD 영역 또는 확인할 시각을 조정하세요.',
  );
});

$('analyze').onclick = safe(async () => {
  if (!source) throw Error('선택 클립을 먼저 불러오세요.');
  readSettings();
  if (sources.length > 1) {
    batchJobs = [];
    batchCancelled = false;
    batchRunning = true;
    updateControls();
    const failures = [];
    try {
      for (const [index, selected] of sources.entries()) {
        if (batchCancelled) break;
        source = selected;
        applySourceKdaDefault();
        applySourceFlashDefault();
        job = await api('jobs', 'POST', {
          sourceId: source.id,
          roi: readRoi(),
          clockRoi: readRoi('clock', '시계 HUD'),
          flash: readFlashOptions(),
          workers: $('workers').value,
          interval: 0.5,
        });
        while (job.status === 'running') {
          setProgress(`${index + 1}/${sources.length} · ${job.stage}`, job.progress || 0);
          await new Promise((resolve) => setTimeout(resolve, 1000));
          job = await api('jobs/' + job.id);
        }
        if (job.status === 'done') batchJobs.push(job.id);
        else if (!batchCancelled) failures.push(`${selected.name}: ${job.error || job.status}`);
        renderEvents();
        await refreshJobs(job.status === 'done' ? job.id : undefined);
      }
    } finally {
      batchRunning = false;
      updateControls();
    }
    clearProgress();
    showMessage(
      `${batchJobs.length}/${sources.length}개 클립 분석 완료${batchCancelled ? ' · 취소됨' : ''}` +
        (failures.length ? `\n${failures.join('\n')}` : '\n완료된 작업을 검토한 뒤 시퀀스를 생성하세요.'),
      failures.length > 0,
    );
    return;
  }
  job = await api('jobs', 'POST', {
    sourceId: source.id,
    roi: readRoi(),
    clockRoi: readRoi('clock', '시계 HUD'),
    flash: readFlashOptions(),
    workers: $('workers').value,
    interval: 0.5,
  });
  clearTimeout(pollTimer);
  setProgress(job.stage || '분석 준비', job.progress || 0);
  showMessage('녹화본 분석을 시작했습니다.');
  updateControls();
  await pollJob();
});

$('cancel').onclick = safe(async () => {
  cancelGeneration = true;
  batchCancelled = true;
  if (isAnalyzing()) await api('jobs/' + job.id + '/cancel', 'POST', {});
  showMessage('취소를 요청했습니다.');
});

$('refresh').onclick = safe(async () => {
  await refreshJobs();
  showMessage('완료된 작업 목록을 새로고침했습니다.');
});

$('jobs').onchange = updateControls;

$('settings-toggle').onclick = () => {
  const expanded = $('settings-toggle').getAttribute('aria-expanded') === 'true';
  setAdvancedSettings(!expanded);
};

$('load-job').onclick = safe(async () => {
  if (generating || isAnalyzing()) throw Error('현재 작업 완료 후 불러오세요.');
  const id = $('jobs').value;
  if (!id) throw Error('불러올 작업을 선택하세요.');
  job = await api('jobs/' + id);
  source = job.source;
  if (!batchJobs.includes(id)) {
    batchJobs = [];
    sources = [source];
  }
  setSettings(job.settings);
  for (const key of ['x', 'y', 'width', 'height'])
    $(key).value = String(job.options.roi[key] * 100);
  const clockRoi = job.options.clockRoi ?? { x: 0.968, y: 0.001, width: 0.025, height: 0.019 };
  const flash = job.options.flash ?? { enabled: true, slot: 'F' };
  $('flash-enabled').checked = flash.enabled;
  $('flash-slot').value = flash.slot;
  const flashRoi = flash.roi ?? {
    x: flash.slot === 'D' ? 0.516 : 0.535,
    y: 0.916,
    width: 0.015,
    height: 0.026,
  };
  for (const key of ['x', 'y', 'width', 'height'])
    $('flash-' + key).value = String(flashRoi[key] * 100);
  $('flash-time').value = String(Math.min(source.out - 1 / source.fpsNum, source.in + 180));
  for (const key of ['x', 'y', 'width', 'height'])
    $('clock-' + key).value = String(clockRoi[key] * 100);
  $('clock-time').value = String(Math.min(source.out - 1 / source.fpsNum, source.in + 120));
  setSourceInfo(describeSources(sources));
  renderEvents();
  clearProgress();
  showMessage('저장된 작업과 수정 사항을 불러왔습니다.');
});

$('generate').onclick = safe(async () => {
  if ((!job || job.status !== 'done') && !batchJobs.length)
    throw Error('완료된 작업을 불러오세요.');
  generating = true;
  cancelGeneration = false;
  updateControls();
  try {
    if (batchJobs.length > 1 || (sources.length > 1 && batchJobs.length)) {
      const plans = [];
      for (const [index, id] of batchJobs.entries()) {
        setProgress(`${index + 1}/${batchJobs.length} · 컷 계획 준비`, 0);
        const plan = await api('jobs/' + id + '/plan', 'POST', { settings: readSettings() });
        if (!plan.clips.length) throw Error(`${plan.source.name}: 생성할 컷이 없습니다.`);
        plans.push(plan);
      }
      const combined = host.combinePlans(plans);
      const result = await host.generate(combined, {
        isCancelled: () => cancelGeneration,
        onProgress: setProgress,
      });
      setProgress('시퀀스 생성 완료', 1);
      showMessage(
        `${batchJobs.length}개 원본을 합쳐 시퀀스 1개를 생성했습니다.\n` +
          `${result.name} · ${result.clips}개 컷 · 프로젝트 폴더: ${result.binName}`,
      );
      return;
    }
    job = await api('jobs/' + job.id);
    const plan = await api('jobs/' + job.id + '/plan', 'POST', { settings: readSettings() });
    if (!plan.clips.length) throw Error('생성할 컷이 없습니다.');
    setProgress('시퀀스 준비', 0);
    const result = await host.generate(plan, {
      isCancelled: () => cancelGeneration,
      onProgress: setProgress,
    });
    setProgress('시퀀스 생성 완료', 1);
    showMessage(
      `${result.name}\n${result.clips}개 컷, 오디오 ${result.audioTracks}개 트랙을 생성하고 검증했습니다.\n프로젝트 폴더: ${result.binName}`,
    );
  } finally {
    generating = false;
  }
});

entrypoints.setup({
  panels: {
    editoflegends: {
      show() {
        updateControls();
        void autoConnect();
      },
      destroy() {
        clearTimeout(pollTimer);
        cancelGeneration = true;
      },
    },
  },
});

updateControls();
void autoConnect();
