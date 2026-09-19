const ppro = require('premierepro');
const { entrypoints, shell, storage } = require('uxp');
const host = require('./premiere.js').adapter(ppro);
const $ = (id) => document.getElementById(id);
const CONNECTION_FILE_KEY = 'editoflegends.connection-file-token';
const ENGINE_TOKEN_KEY = 'editoflegends.engine-token';
const ENGINE_URL = 'http://localhost:4317';
const ENGINE_VERSION = '0.2.2';
const ENGINE_START_URL = 'editoflegends://start';

let connection = null;
let source = null;
let job = null;
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
  return job?.status === 'running';
}

function updateControls() {
  const connected = Boolean(connection);
  const analyzing = isAnalyzing();
  const busy = analyzing || generating;
  $('connect').disabled = busy;
  $('connection-file').disabled = busy;
  $('source').disabled = !connected || busy;
  $('review').disabled = !connected;
  $('analyze').disabled = !connected || !source || busy;
  $('cancel').disabled = !busy;
  $('refresh').disabled = !connected || busy;
  $('load-job').disabled = !connected || busy || !$('jobs').value;
  $('generate').disabled = !connected || job?.status !== 'done' || busy;
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
  if (
    candidate?.url !== ENGINE_URL ||
    typeof candidate.token !== 'string' ||
    !candidate.token
  )
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
        throw Error('다른 인증 정보로 실행 중인 엔진이 있습니다. 기존 엔진을 종료한 뒤 다시 시도하세요.');
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
  values.types = ['kill', 'assist', 'death'].filter((type) => $(type).checked);
  if (!values.types.length) throw Error('이벤트 유형을 하나 이상 선택하세요.');
  return values;
}

function readRoi() {
  const values = Object.fromEntries(
    ['x', 'y', 'width', 'height'].map((key) => [key, Number($(key).value) / 100]),
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
    throw Error('HUD 영역이 화면 밖으로 나가지 않도록 입력하세요.');
  return values;
}

function setSettings(settings = {}) {
  const defaults = { before: 11, after: 7, gap: 15 };
  for (const key of Object.keys(defaults)) $(key).value = String(settings[key] ?? defaults[key]);
  for (const type of ['kill', 'assist', 'death'])
    $(type).checked = (settings.types ?? ['kill', 'assist', 'death']).includes(type);
}

function setSourceInfo(value) {
  $('source-info').classList.toggle('empty', !value);
  $('source-info').textContent = value || '타임라인에서 영상 클립 하나를 선택하세요.';
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
    option.textContent = item.source.name + ' · ' + new Date(item.startedAt).toLocaleTimeString();
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
  $('summary').textContent =
    `${events.length}개 이벤트 · 포함 ${included}개 · K/D/A ${job.result?.finalKda?.join(' / ') ?? '—'} · 검토 ${events.filter((event) => event.review).length}개`;
  if (!events.length) {
    const empty = document.createElement('div');
    empty.className = 'empty-events';
    empty.textContent = '감지된 이벤트가 없습니다.';
    list.appendChild(empty);
    return;
  }
  const labels = { kill: '킬', assist: '어시', death: '데스' };
  const tracks = { kill: 'V1', assist: 'V2', death: 'V3' };
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
  source = await api('sources', 'POST', await host.selectedSource());
  job = null;
  renderEvents();
  clearProgress();
  setSourceInfo(
    `${source.name}\n${source.in.toFixed(2)}–${source.out.toFixed(2)}초 · ${source.width}×${source.height} · ${source.fpsNum / source.fpsDen}fps`,
  );
  showMessage('소스를 불러왔습니다. HUD 영역을 확인한 뒤 분석하세요.');
});

$('review').onclick = safe(async () => {
  if (!connection) throw Error('먼저 엔진을 연결하세요.');
  const result = await shell.openExternal(
    connection.url + '/#' + encodeURIComponent(connection.token),
    'EditOfLegends 분석 결과와 HUD 영역을 브라우저에서 검토합니다.',
  );
  if (result) throw Error('검토 화면을 열지 못했습니다: ' + result);
});

$('analyze').onclick = safe(async () => {
  if (!source) throw Error('선택 클립을 먼저 불러오세요.');
  readSettings();
  job = await api('jobs', 'POST', {
    sourceId: source.id,
    roi: readRoi(),
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
  setSettings(job.settings);
  for (const key of ['x', 'y', 'width', 'height'])
    $(key).value = String(job.options.roi[key] * 100);
  setSourceInfo(
    `${source.name}\n${source.in.toFixed(2)}–${source.out.toFixed(2)}초 · ${source.width}×${source.height}`,
  );
  renderEvents();
  clearProgress();
  showMessage('저장된 작업과 수정 사항을 불러왔습니다.');
});

$('generate').onclick = safe(async () => {
  if (!job || job.status !== 'done') throw Error('완료된 작업을 불러오세요.');
  generating = true;
  cancelGeneration = false;
  updateControls();
  try {
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
      `${result.name}\n${result.clips}개 컷, 오디오 ${result.audioTracks}개 트랙을 생성하고 검증했습니다.`,
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
