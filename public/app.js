import { createAnsi, stripAnsi, normalizeCR } from './ansi.js';

/* ================================================================ utils */

const $ = (s, el = document) => el.querySelector(s);

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2).toLowerCase(), v);
    else if (k === 'class') el.className = v;
    else if (k === 'html') el.innerHTML = v;
    else if (k === 'value' || k === 'checked' || k === 'disabled' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const c of kids.flat(Infinity)) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

function fill(el, ...kids) {
  el.replaceChildren(...kids.flat(Infinity).filter((k) => k != null && k !== false));
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(path, {
    method,
    headers: method === 'GET' ? {} : { 'Content-Type': 'application/json' },
    body: method === 'GET' ? undefined : JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code });
  return data;
}

let toastTimer;
function toast(msg, err) {
  const t = $('#toast');
  t.textContent = msg;
  t.className = `toast show${err ? ' err' : ''}`;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.className = 'toast'), err ? 5000 : 2400);
}

const fmtDur = (ms) => {
  if (ms == null || ms < 0) return '';
  const s = Math.floor(ms / 1000);
  return s < 60 ? `${(ms / 1000).toFixed(s < 10 ? 1 : 0)}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, '0')}s`;
};
function relTime(iso) {
  const d = (Date.now() - Date.parse(iso)) / 1000;
  if (d < 45) return 'just now';
  if (d < 3600) return `${Math.round(d / 60)}m ago`;
  if (d < 86400) return `${Math.round(d / 3600)}h ago`;
  return new Date(iso).toLocaleDateString();
}
const STATUS_ICON = { passed: '✓', failed: '✕', cancelled: '⊘', interrupted: '⊘', queued: '○' };
function statusIcon(status) {
  return h('span', { class: `tab-icon s-${status}` }, status === 'running' ? h('span', { class: 'spin' }) : STATUS_ICON[status] || '•');
}
const isActive = (s) => s === 'running' || s === 'queued';

function setFavicon(status) {
  const color = { passed: '#1f9d55', failed: '#d1383d', running: '#e5ac2e' }[status] || '#888';
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><circle cx='8' cy='8' r='6' fill='${color}'/></svg>`;
  $('#favicon').href = `data:image/svg+xml,${encodeURIComponent(svg)}`;
}

/* ================================================================ state */

const state = {
  runs: [],
  view: null, // 'composer' | 'run'
  // run view
  run: null,
  runStream: null,
  active: 'all',
  follow: true,
  scroll: {},
  logs: {}, // procId -> raw text
  all: [], // [{pid, html}]  (multiplexed complete lines)
  partial: {}, // procId -> incomplete trailing line for the All tab
  ansiActive: null,
  userPickedTab: false,
  // composer
  c: { path: '', info: null, plan: [], filter: '', save: true, saveTarget: 'user', loading: false, error: '', recents: [] },
};

const MAX_UI_CHARS = 1_200_000;
const MAX_ALL_LINES = 20_000;
let keySeq = 0;
const planItem = (p) => ({ key: ++keySeq, label: p.label || '', command: p.command || '', cwd: p.cwd || '', enabled: p.enabled !== false });

/* ================================================================ router */

function navigate(url, replace) {
  if (url !== location.pathname + location.search) history[replace ? 'replaceState' : 'pushState']({}, '', url);
  route();
}
window.addEventListener('popstate', route);
document.addEventListener('click', (e) => {
  const a = e.target.closest('a[href^="/"]');
  if (!a || e.ctrlKey || e.metaKey || e.shiftKey || e.button !== 0) return;
  e.preventDefault();
  navigate(a.getAttribute('href'));
});

function route() {
  const m = location.pathname.match(/^\/run\/([^/]+)/);
  if (m) openRun(decodeURIComponent(m[1]));
  else openComposer(new URLSearchParams(location.search));
  renderSidebar();
}

/* ================================================================ global stream */

function connectGlobal() {
  const es = new EventSource('/api/events');
  es.onopen = () => {
    $('#conn').className = 'conn on';
    $('#conn').title = 'Connected to local server';
  };
  es.onerror = () => {
    $('#conn').className = 'conn';
    $('#conn').title = 'Server unreachable — retrying…';
  };
  es.onmessage = (e) => {
    const ev = JSON.parse(e.data);
    if (ev.type === 'runs.list') state.runs = ev.runs;
    else if (ev.type === 'runs.update' && ev.run) {
      const i = state.runs.findIndex((r) => r.runId === ev.run.runId);
      if (i >= 0) state.runs[i] = ev.run;
      else state.runs.unshift(ev.run);
      if (ev.event === 'run.finished') notifyFinished(ev.run);
    } else if (ev.type === 'run.focus') {
      navigate(`/run/${ev.runId}`);
      window.focus();
    }
    renderSidebar();
  };
}

function notifyFinished(run) {
  if (document.hasFocus() || !('Notification' in window) || Notification.permission !== 'granted') return;
  const n = new Notification(`${run.status === 'passed' ? '✓ Passed' : '✕ ' + run.status}: ${run.repoName}`, {
    body: run.processes.map((p) => `${STATUS_ICON[p.status] || ''} ${p.label}`).join('   '),
    tag: run.runId,
  });
  n.onclick = () => {
    window.focus();
    navigate(`/run/${run.runId}`);
  };
}

/* ================================================================ sidebar */

function renderSidebar() {
  const box = $('#runs');
  const current = state.view === 'run' ? state.run?.runId : null;
  $('#newRunBtn').classList.toggle('active', state.view === 'composer');
  if (!state.runs.length) {
    fill(box, h('div', { class: 'empty-side' }, 'No runs yet. Pick a folder and start one, or push with the hook installed.'));
    return;
  }
  fill(box, 
    ...state.runs.map((r) =>
      h('a', { class: `run-item${r.runId === current ? ' active' : ''}`, href: `/run/${r.runId}`, title: r.repoDir },
        h('span', { class: `dot s-${r.status}` }),
        h('div', { class: 'ri-title' }, r.repoName),
        h('div', { class: 'ri-sub' }, [r.source === 'hook' ? 'pre-push' : 'manual', r.branch, relTime(r.startedAt), r.durationMs != null && fmtDur(r.durationMs)].filter(Boolean).join(' · ')),
        h('div', { class: 'ri-minis' }, r.processes.map((p) => h('span', { class: `mini s-${p.status}`, title: `${p.label}: ${p.status}` }))),
      ),
    ),
  );
}

/* ================================================================ run view */

function closeRunStream() {
  state.runStream?.close();
  state.runStream = null;
}

function openRun(runId) {
  if (state.view === 'run' && state.run?.runId === runId && state.runStream) return;
  closeRunStream();
  state.view = 'run';
  state.run = null;
  state.active = 'all';
  state.scroll = {};
  state.follow = true;
  state.userPickedTab = false;
  fill($('#main'), h('div', { class: 'not-found' }, 'Loading…'));
  const es = new EventSource(`/api/runs/${encodeURIComponent(runId)}/events`);
  state.runStream = es;
  es.onmessage = (e) => onRunEvent(JSON.parse(e.data));
}

function resetLogs(run) {
  state.logs = {};
  state.all = [];
  state.partial = {};
  for (const p of run.processes) {
    state.logs[p.id] = '';
    state.partial[p.id] = '';
    if (p.log) ingest(p.id, p.log, false);
  }
}

function procById(id) {
  return state.run?.processes.find((p) => p.id === id);
}

/** Store a chunk; returns nothing. Rendering is done separately. */
function ingest(pid, chunk, live) {
  state.logs[pid] = (state.logs[pid] || '') + chunk;
  let trimmed = false;
  if (state.logs[pid].length > MAX_UI_CHARS) {
    state.logs[pid] = state.logs[pid].slice(-MAX_UI_CHARS * 0.8);
    trimmed = true;
  }
  // multiplexed "All" tab: only complete lines
  const text = (state.partial[pid] || '') + chunk;
  const lines = text.split('\n');
  state.partial[pid] = lines.pop();
  const newLines = lines.map((l) => ({ pid, text: l }));
  state.all.push(...newLines);
  if (state.all.length > MAX_ALL_LINES) {
    state.all.splice(0, state.all.length - MAX_ALL_LINES);
    trimmed = true;
  }
  if (!live) return;
  if (trimmed) return renderLog();
  if (state.active === pid) appendLogHtml(state.ansiActive(chunk));
  else if (state.active === 'all' && newLines.length) appendLogHtml(newLines.map(allLineHtml).join(''));
}

function flushPartial(pid) {
  const rest = state.partial[pid];
  if (!rest) return;
  state.partial[pid] = '';
  const line = { pid, text: rest };
  state.all.push(line);
  if (state.active === 'all') appendLogHtml(allLineHtml(line));
}

function allLineHtml(l) {
  const p = procById(l.pid);
  const label = (p?.label || l.pid).replace(/&/g, '&amp;').replace(/</g, '&lt;');
  const color = state.run ? (state.run.processes.findIndex((x) => x.id === l.pid) % 6) + 9 : 7;
  return `<span class="pfx a-fg${color}">[${label}]</span> ${createAnsi()(stripCR(l.text))}\n`;
}
const stripCR = (s) => normalizeCR(s + '\n').replace(/\n$/, '');

function onRunEvent(ev) {
  const run = state.run;
  switch (ev.type) {
    case 'error':
      closeRunStream();
      fill($('#main'), h('div', { class: 'not-found' }, h('h2', {}, 'Run not found'), h('p', {}, 'It may have been pruned from history.'), h('a', { class: 'btn', href: '/new' }, 'Start a new run')));
      return;
    case 'snapshot':
      state.run = ev.run;
      resetLogs(ev.run);
      renderRunView();
      return;
    case 'process.started': {
      const p = procById(ev.processId);
      if (!p) return;
      const rerun = p.attempt && ev.attempt > p.attempt;
      Object.assign(p, { status: 'running', pid: ev.pid, attempt: ev.attempt, startedAt: ev.startedAt, exitCode: null, durationMs: null });
      if (rerun) {
        state.logs[p.id] = '';
        state.partial[p.id] = '';
        state.all.push({ pid: p.id, text: `\x1b[2m── re-run #${ev.attempt} ──\x1b[0m` });
        renderLog();
      }
      run.status = 'running';
      break;
    }
    case 'run.resumed':
      Object.assign(run, { status: 'running', ok: null, finishedAt: null, durationMs: null });
      break;
    case 'process.log':
      ingest(ev.processId, ev.chunk, true);
      return;
    case 'process.exited': {
      const p = procById(ev.processId);
      if (!p) return;
      Object.assign(p, { status: ev.status, exitCode: ev.exitCode, durationMs: ev.durationMs });
      flushPartial(p.id);
      break;
    }
    case 'run.finished':
      Object.assign(run, { status: ev.status, ok: ev.ok, durationMs: ev.durationMs, finishedAt: new Date().toISOString() });
      if (!ev.ok && !state.userPickedTab) {
        const failed = run.processes.find((p) => p.status === 'failed');
        if (failed) return selectTab(failed.id, false);
      }
      break;
    default:
      return;
  }
  renderRunChrome();
}

function renderRunView() {
  const r = state.run;
  fill($('#main'), 
    h('header', { class: 'run-head' },
      h('div', { class: 'rh-title' },
        h('h1', {}, r.repoName),
        r.branch && h('span', { class: 'chip mono' }, `⎇ ${r.branch}`),
        h('span', { class: 'chip' }, r.source === 'hook' ? 'pre-push hook' : 'manual run'),
        r.presetSource && r.presetSource !== 'manual' && h('span', { class: 'chip', title: 'Where the commands came from' }, `preset: ${r.presetSource}`),
      ),
      h('div', { class: 'rh-actions', id: 'rhActions' }),
      h('div', { class: 'rh-path mono', title: r.repoDir }, r.repoDir),
    ),
    h('div', { id: 'banner' }),
    h('nav', { class: 'tabs', id: 'tabs', role: 'tablist' }),
    h('div', { class: 'logbar', id: 'logbar' }),
    h('pre', { class: 'log', id: 'log', onScroll: onLogScroll }),
    h('footer', { class: 'summary', id: 'summary' }),
  );
  renderRunChrome();
  renderLog();
}

function renderRunChrome() {
  const r = state.run;
  if (!r || !$('#tabs')) return;
  const running = r.status === 'running';
  document.title = `${{ running: '⏳', passed: '✓', failed: '✕' }[r.status] || '⊘'} ${r.repoName} · Local CI`;
  setFavicon(r.status);

  fill($('#rhActions'), 
    h('span', { class: `pill s-${r.status}` }, running ? h('span', { class: 'spin' }) : null, r.status),
    h('span', { class: 'elapsed', id: 'elapsed' }, elapsed(r)),
    running && h('button', { class: 'btn danger', onClick: () => stopRun() }, 'Stop all'),
    !running && h('button', { class: 'btn', onClick: rerunAll, title: 'Start a new run with the same commands' }, '↻ Re-run all'),
    h('a', { class: 'btn', href: `/new?from=${encodeURIComponent(r.runId)}` }, 'Edit & run'),
  );

  const banner = $('#banner');
  if (running) fill(banner, );
  else {
    const failed = r.processes.filter((p) => p.status === 'failed');
    fill(banner, 
      h('div', { class: `banner s-${r.status}` },
        r.status === 'passed' ? `✓ All ${r.processes.length} commands passed in ${fmtDur(r.durationMs)}` : r.status === 'failed' ? `✕ ${failed.length} of ${r.processes.length} failed: ${failed.map((p) => p.label).join(', ')}` : `⊘ Run ${r.status}`,
        r.source === 'hook' && h('span', { class: 'muted small' }, r.status === 'passed' ? '— push continues' : '— push blocked'),
      ),
    );
  }

  const tab = (id, label, status, extra, n) =>
    h('button', { class: `tab${state.active === id ? ' active' : ''}`, role: 'tab', 'aria-selected': state.active === id ? 'true' : 'false', onClick: () => selectTab(id, true) },
      status && statusIcon(status), label, extra, n != null && n < 10 && h('kbd', {}, n));
  fill($('#tabs'), 
    tab('all', 'All', null, h('span', { class: 'dur' }, `${r.processes.length}`), 0),
    ...r.processes.map((p, i) => tab(p.id, p.label, p.status, h('span', { class: 'dur', 'data-dur': p.id }, procDur(p)), i + 1)),
  );

  const p = procById(state.active);
  fill($('#logbar'), 
    p ? h('code', { class: 'cmd', title: `${p.command}\n${p.cwd}` }, `$ ${p.command}`) : h('span', { class: 'cmd muted' }, 'All processes, interleaved by line'),
    p && p.exitCode != null && h('span', { class: `chip ${p.exitCode === 0 ? 'ok' : ''}`, style: p.exitCode ? 'color:var(--fail)' : '' }, `exit ${p.exitCode}`),
    p?.truncated && h('span', { class: 'chip warn', title: 'Older output was dropped to keep the UI fast' }, 'truncated'),
    h('label', {}, h('input', { type: 'checkbox', checked: state.follow, onChange: (e) => { state.follow = e.target.checked; if (state.follow) scrollBottom(); } }), 'Follow'),
    h('button', { class: 'btn sm', onClick: copyLog }, 'Copy'),
    p && p.status === 'running' && h('button', { class: 'btn sm danger', onClick: () => stopRun(p.id) }, 'Stop'),
    p && !isActive(p.status) && h('button', { class: 'btn sm', onClick: () => rerunProc(p.id) }, '↻ Re-run'),
  );

  const c = { passed: 0, failed: 0, running: 0, other: 0 };
  for (const x of r.processes) c[x.status in c ? x.status : 'other']++;
  fill($('#summary'), 
    h('span', {}, h('b', { class: 'p' }, c.passed), ' passed'),
    h('span', {}, h('b', { class: 'r' }, c.running), ' running'),
    h('span', {}, h('b', { class: 'f' }, c.failed), ' failed'),
    c.other ? h('span', {}, h('b', {}, c.other), ' other') : null,
    h('span', { class: 'muted', style: 'margin-left:auto' }, 'Keys: 0 = All · 1–9 = tabs · F = follow'),
  );
}

const procDur = (p) => (p.status === 'running' && p.startedAt ? fmtDur(Date.now() - Date.parse(p.startedAt)) : fmtDur(p.durationMs));
const elapsed = (r) => (r.status === 'running' ? fmtDur(Date.now() - Date.parse(r.startedAt)) : fmtDur(r.durationMs));

setInterval(() => {
  if (state.view !== 'run' || !state.run || state.run.status !== 'running') return;
  const el = $('#elapsed');
  if (el) el.textContent = elapsed(state.run);
  for (const p of state.run.processes) {
    const d = document.querySelector(`[data-dur="${CSS.escape(p.id)}"]`);
    if (d) d.textContent = procDur(p);
  }
}, 500);

function selectTab(id, byUser) {
  const log = $('#log');
  if (log) state.scroll[state.active] = { top: log.scrollTop, follow: state.follow };
  state.active = id;
  if (byUser) state.userPickedTab = true;
  const saved = state.scroll[id];
  state.follow = saved ? saved.follow : true;
  renderRunChrome();
  renderLog(saved && !saved.follow ? saved.top : null);
}

function renderLog(restoreTop) {
  const log = $('#log');
  if (!log) return;
  state.ansiActive = createAnsi();
  let html;
  if (state.active === 'all') html = state.all.map(allLineHtml).join('');
  else html = state.ansiActive(state.logs[state.active] || '');
  log.innerHTML = html || '<span class="log-empty">Waiting for output…</span>';
  if (restoreTop != null) log.scrollTop = restoreTop;
  else if (state.follow) scrollBottom();
}

function appendLogHtml(html) {
  const log = $('#log');
  if (!log || !html) return;
  const empty = log.querySelector('.log-empty');
  if (empty) empty.remove();
  log.insertAdjacentHTML('beforeend', html);
  if (state.follow) scrollBottom();
}

let autoScrolling = false;
function scrollBottom() {
  const log = $('#log');
  if (!log) return;
  autoScrolling = true;
  log.scrollTop = log.scrollHeight;
  requestAnimationFrame(() => (autoScrolling = false));
}
function onLogScroll(e) {
  if (autoScrolling) return;
  const el = e.target;
  const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 30;
  if (atBottom !== state.follow) {
    state.follow = atBottom;
    const cb = $('#logbar input[type=checkbox]');
    if (cb) cb.checked = atBottom;
  }
}

async function copyLog() {
  const text = state.active === 'all'
    ? state.all.map((l) => `[${procById(l.pid)?.label || l.pid}] ${stripAnsi(stripCR(l.text))}`).join('\n')
    : stripAnsi(normalizeCR(state.logs[state.active] || ''));
  try {
    await navigator.clipboard.writeText(text);
    toast('Log copied');
  } catch {
    toast('Clipboard not available', true);
  }
}

async function stopRun(processId) {
  try {
    await api(`/api/runs/${state.run.runId}/stop`, { method: 'POST', body: { processId } });
  } catch (e) {
    toast(e.message, true);
  }
}
async function rerunProc(processId) {
  try {
    await api(`/api/runs/${state.run.runId}/rerun`, { method: 'POST', body: { processId } });
  } catch (e) {
    toast(e.message, true);
  }
}
async function rerunAll() {
  try {
    const r = await api(`/api/runs/${state.run.runId}/rerun`, { method: 'POST', body: {} });
    navigate(`/run/${r.runId}`);
  } catch (e) {
    toast(e.message, true);
  }
}

document.addEventListener('keydown', (e) => {
  if (state.view !== 'run' || !state.run || e.ctrlKey || e.metaKey || e.altKey) return;
  if (/^(INPUT|TEXTAREA|SELECT)$/.test(document.activeElement?.tagName)) return;
  if (e.key === '0') selectTab('all', true);
  else if (/^[1-9]$/.test(e.key)) {
    const p = state.run.processes[Number(e.key) - 1];
    if (p) selectTab(p.id, true);
  } else if (e.key === 'f' || e.key === 'F') {
    state.follow = !state.follow;
    renderRunChrome();
    if (state.follow) scrollBottom();
  }
});

/* ================================================================ composer */

async function openComposer(params) {
  closeRunStream();
  state.view = 'composer';
  state.run = null;
  document.title = 'New run · Local CI';
  setFavicon(null);
  const c = state.c;
  c.error = '';
  renderComposer();
  api('/api/recents').then((r) => { c.recents = r; renderRecents(); }).catch(() => {});

  const from = params.get('from');
  const repo = params.get('repo');
  if (from) {
    try {
      const run = await api(`/api/runs/${encodeURIComponent(from)}?logs=0`);
      await loadRepo(run.repoDir, run.processes.map((p) => ({ label: p.label, command: p.command, cwd: p.cwdRel })));
    } catch (e) {
      toast(e.message, true);
    }
  } else if (repo) await loadRepo(repo);
  else if (!c.info) {
    const recents = await api('/api/recents').catch(() => []);
    if (recents[0]) {
      c.path = recents[0].dir;
      renderComposer();
    }
  }
}

async function loadRepo(path, planOverride) {
  const c = state.c;
  c.path = (path || '').trim();
  if (!c.path) return;
  c.loading = true;
  c.error = '';
  renderComposer();
  try {
    c.info = await api(`/api/inspect?path=${encodeURIComponent(c.path)}`);
    c.path = c.info.repo.dir;
    const base = planOverride || c.info.preset?.processes || c.info.recommended;
    c.plan = base.map(planItem);
    c.saveTarget = c.info.preset?.source === 'repo' ? 'repo' : 'user';
  } catch (e) {
    c.info = null;
    c.plan = [];
    c.error = e.message;
  }
  c.loading = false;
  renderComposer();
}

function renderComposer() {
  const c = state.c;
  const info = c.info;
  const main = $('#main');
  // keep focus/caret in the path input across re-renders
  const pathFocused = document.activeElement?.id === 'repoPath';

  const repoCard = h('section', { class: 'card' },
    h('h2', {}, 'Folder'),
    h('div', { class: 'repo-row' },
      h('input', {
        id: 'repoPath', class: 'field mono', placeholder: 'C:\\path\\to\\repo  — paste a path, browse, or pick a recent one', value: c.path, spellcheck: 'false',
        onInput: (e) => (c.path = e.target.value),
        onKeydown: (e) => e.key === 'Enter' && loadRepo(c.path),
      }),
      h('button', { class: 'btn', onClick: nativePick, title: 'Open the system folder picker' }, 'Browse…'),
      h('button', { class: 'btn', onClick: () => openFsDialog(c.path), title: 'Browse folders inside the dashboard' }, 'Folders'),
      h('button', { class: 'btn primary', onClick: () => loadRepo(c.path), disabled: c.loading }, c.loading ? 'Loading…' : 'Load'),
    ),
    h('div', { class: 'recents', id: 'recents' }),
    c.error && h('div', { class: 'error' }, c.error),
    info && repoInfo(info),
  );

  const kids = [h('h1', {}, 'New run'), repoCard];
  if (info) {
    kids.push(h('div', { class: 'cols' }, planCard(), suggestionsCard()));
    kids.push(runBar());
  } else if (!c.loading) {
    kids.push(h('div', { class: 'card muted' },
      'Pick a folder to see the commands detected for it (npm/pnpm/yarn scripts, composer scripts, vendor/bin tools, pytest/ruff, go, cargo, dotnet, maven/gradle, make/just/task targets, husky/lefthook hooks and GitHub/GitLab CI steps). ',
      'You can also type any command by hand. Runs work with or without a git hook.'));
  }
  fill(main, h('div', { class: 'composer' }, ...kids));
  renderRecents();
  renderSuggestionsList();
  updateRunButton();
  if (pathFocused) {
    const el = $('#repoPath');
    el.focus();
    el.setSelectionRange(el.value.length, el.value.length);
  }
}

function renderRecents() {
  const box = $('#recents');
  if (!box) return;
  const c = state.c;
  fill(box, 
    ...c.recents.slice(0, 8).map((r) =>
      h('span', { class: 'recent', title: r.dir, onClick: () => loadRepo(r.dir) },
        r.name,
        h('button', { class: 'x', title: 'Forget', 'aria-label': `Forget ${r.name}`, onClick: async (e) => { e.stopPropagation(); c.recents = await api('/api/recents/forget', { method: 'POST', body: { dir: r.dir } }); renderRecents(); } }, '×'),
      ),
    ),
  );
}

function repoInfo(info) {
  const { repo, hook, preset, techs } = info;
  const presetLabel = { repo: '.local-ci.json', user: 'saved on this machine', legacy: '.git/hooks/pre-push-ci.json' }[preset?.source];
  return h('div', {},
    h('div', { class: 'repo-info' },
      h('span', { class: 'name' }, repo.name),
      repo.branch && h('span', { class: 'chip mono' }, `⎇ ${repo.branch}`),
      !repo.isGit && h('span', { class: 'chip warn' }, 'not a git repo'),
      h('span', { class: `chip ${preset ? 'ok' : ''}` }, preset ? `preset: ${presetLabel}` : 'no preset — using detected suggestions'),
      techs.length > 0 && h('span', { class: 'techs' }, techs.map((t) => h('span', { class: 'chip' }, t))),
    ),
    hook.supported && hookBox(hook),
  );
}

function hookBox(hook) {
  let text;
  let btn;
  if (hook.installed) {
    text = ['✓ pre-push hook installed — every ', h('code', {}, 'git push'), ' runs this folder\'s preset here and blocks on failure.'];
    btn = h('button', { class: 'btn sm', onClick: () => hookAction('uninstall') }, hook.hasBackup ? 'Remove (restore previous)' : 'Remove hook');
  } else {
    text = hook.otherHook
      ? ['A different pre-push hook exists. Installing will back it up as ', h('code', {}, 'pre-push.local-ci-backup'), ' (git-lfs hooks stay chained).']
      : ['No pre-push hook — that\'s fine, run manually below. Optionally install one so ', h('code', {}, 'git push'), ' runs the saved preset automatically.'];
    btn = h('button', { class: 'btn sm', onClick: () => hookAction('install') }, 'Install pre-push hook');
  }
  return h('div', { class: 'hook-box' },
    h('span', { class: 'grow' }, ...text, hook.hooksPath ? h('div', { class: 'small', style: 'color:var(--run)' }, `core.hooksPath is "${hook.hooksPath}" — tools like husky may overwrite this hook.`) : null),
    btn);
}

async function hookAction(kind) {
  const c = state.c;
  if (kind === 'install' && !c.info.preset) {
    if (!confirm('This folder has no saved preset yet, so the hook would run the auto-detected commands. Save the current command list as the preset first?')) return;
    await savePreset(true);
  }
  try {
    const r = await api(`/api/hook/${kind}`, { method: 'POST', body: { repoPath: c.path } });
    c.info.hook = r.hook;
    toast(kind === 'install' ? `Hook installed${r.backedUp ? ' (previous hook backed up)' : ''}` : `Hook removed${r.restored ? ', previous hook restored' : ''}`);
    renderComposer();
  } catch (e) {
    toast(e.message, true);
  }
}

function planCard() {
  const c = state.c;
  const enabled = c.plan.filter((p) => p.enabled && p.command.trim()).length;
  const rows = c.plan.map((p, i) =>
    h('div', { class: `plan-row${p.enabled ? '' : ' off'}` },
      h('input', { type: 'checkbox', checked: p.enabled, title: 'Include in run', onChange: (e) => { p.enabled = e.target.checked; renderPlan(); } }),
      h('input', { class: 'field f-label', value: p.label, placeholder: 'label', onInput: (e) => (p.label = e.target.value) }),
      h('input', { class: 'field mono f-cmd', value: p.command, placeholder: 'command, e.g. pnpm run lint', spellcheck: 'false', 'data-key': p.key, onInput: (e) => { p.command = e.target.value; updateRunButton(); }, onKeydown: (e) => (e.ctrlKey || e.metaKey) && e.key === 'Enter' && startRun() }),
      h('input', { class: 'field mono f-cwd', value: p.cwd, placeholder: './', title: 'Sub-folder to run in (relative to the folder)', spellcheck: 'false', onInput: (e) => (p.cwd = e.target.value) }),
      h('button', { class: 'icon-btn', title: 'Remove', 'aria-label': 'Remove command', onClick: () => { c.plan.splice(i, 1); renderPlan(); } }, '✕'),
    ),
  );
  return h('section', { class: 'card', id: 'planCard' },
    h('h2', {}, 'Commands', h('span', { class: 'chip' }, `${enabled} to run in parallel`), h('span', { class: 'spacer' })),
    c.plan.length
      ? h('div', { class: 'plan-rows' },
          h('div', { class: 'plan-row plan-head' }, h('span'), h('span', {}, 'Label'), h('span', {}, 'Command'), h('span', {}, 'Sub-folder'), h('span')),
          rows)
      : h('div', { class: 'plan-empty' }, 'No commands yet — click suggestions on the right, or add one by hand.'),
    h('div', { class: 'plan-actions' },
      h('button', { class: 'btn sm', onClick: () => { c.plan.push(planItem({ enabled: true })); renderPlan(true); } }, '+ Add command'),
      c.info?.recommended?.length > 0 && h('button', { class: 'btn sm', onClick: () => { c.plan = c.info.recommended.map(planItem); renderPlan(); } }, 'Reset to recommended'),
      c.info?.preset && h('button', { class: 'btn sm', onClick: () => { c.plan = c.info.preset.processes.map(planItem); renderPlan(); } }, 'Reset to saved preset'),
      c.plan.length > 0 && h('button', { class: 'btn sm', onClick: () => { c.plan = []; renderPlan(); } }, 'Clear'),
    ),
  );
}

function renderPlan(focusLast) {
  const old = $('#planCard');
  if (!old) return;
  old.replaceWith(planCard());
  renderSuggestionsList();
  updateRunButton();
  if (focusLast) {
    const inputs = document.querySelectorAll('#planCard .f-cmd');
    inputs[inputs.length - 1]?.focus();
  }
}

function suggestionsCard() {
  const c = state.c;
  return h('section', { class: 'card' },
    h('h2', {}, 'Suggestions', h('span', { class: 'spacer' }), h('span', { class: 'star' }, '★'), h('span', { class: 'small', style: 'text-transform:none;letter-spacing:0' }, 'recommended')),
    h('input', { class: 'field sugg-search', placeholder: 'Filter suggestions…', value: c.filter, onInput: (e) => { c.filter = e.target.value; renderSuggestionsList(); } }),
    h('div', { id: 'suggList' }),
  );
}

function renderSuggestionsList() {
  const box = $('#suggList');
  const c = state.c;
  if (!box || !c.info) return;
  const inPlan = new Set(c.plan.map((p) => p.command.trim()));
  const q = c.filter.trim().toLowerCase();
  const groups = c.info.groups
    .map((g) => ({ ...g, items: g.items.filter((i) => !q || `${i.label} ${i.command} ${i.tags.join(' ')} ${g.tech}`.toLowerCase().includes(q)) }))
    .filter((g) => g.items.length);
  if (!groups.length) {
    fill(box, h('div', { class: 'muted' }, c.info.groups.length ? 'Nothing matches the filter.' : 'Nothing detected in this folder. Add commands by hand on the left.'));
    return;
  }
  fill(box, 
    ...groups.map((g) => {
      const recs = g.items.filter((i) => i.recommended && !inPlan.has(i.command));
      return h('div', { class: 'sugg-group' },
        h('div', { class: 'sg-head' },
          h('span', { class: 'sg-tech' }, g.tech),
          h('span', { class: 'sg-title' }, g.title, g.meta ? ` · ${g.meta}` : ''),
          h('span', { class: 'spacer' }),
          recs.length > 0 && h('button', { class: 'btn sm', onClick: () => addSuggestions(recs) }, `+ ${recs.length} recommended`),
        ),
        h('div', { class: 'sugg-items' },
          g.items.map((i) => {
            const added = inPlan.has(i.command);
            return h('button', { class: `sugg${added ? ' added' : ''}`, title: `${i.command}${i.detail ? `\n\n${i.detail}` : ''}${added ? '\n\n(already in the list)' : ''}`, onClick: () => addSuggestions([i]) },
              h('span', { class: 'plus' }, added ? '✓' : '+'),
              h('span', {}, h('span', { class: 'lbl' }, i.label, i.recommended ? h('span', { class: 'star' }, ' ★') : null), h('code', { class: 'cmd' }, i.command)),
              h('span', { class: 'tags' }, i.tags.slice(0, 2).map((t) => h('span', { class: `tag ${t}` }, t === 'long-running' ? 'long' : t))),
            );
          }),
        ),
      );
    }),
  );
}

function addSuggestions(items) {
  const c = state.c;
  const have = new Set(c.plan.map((p) => p.command.trim()));
  let n = 0;
  for (const i of items) {
    if (have.has(i.command)) continue;
    if (i.tags?.includes('long-running') && !confirm(`"${i.label}" looks like a long-running/watch command and may never finish. Add it anyway?`)) continue;
    c.plan.push(planItem({ label: i.label, command: i.command, enabled: true }));
    have.add(i.command);
    n++;
  }
  if (n) renderPlan();
}

function runBar() {
  const c = state.c;
  return h('div', { class: 'runbar' },
    h('label', {},
      h('input', { type: 'checkbox', checked: c.save, onChange: (e) => (c.save = e.target.checked) }),
      'Save as this folder\'s preset'),
    h('select', { class: 'field', onChange: (e) => (c.saveTarget = e.target.value), title: 'Where to store the preset' },
      h('option', { value: 'user', selected: c.saveTarget === 'user' }, 'on this machine'),
      h('option', { value: 'repo', selected: c.saveTarget === 'repo' }, 'in .local-ci.json (repo)'),
    ),
    h('button', { class: 'btn sm', onClick: () => savePreset(false) }, 'Save only'),
    h('span', { class: 'grow' }),
    h('span', { class: 'muted small' }, 'Ctrl+Enter'),
    h('button', { class: 'btn primary', id: 'runBtn', onClick: startRun }, '▶ Run'),
  );
}

function updateRunButton() {
  const btn = $('#runBtn');
  if (!btn) return;
  const n = state.c.plan.filter((p) => p.enabled && p.command.trim()).length;
  btn.textContent = n ? `▶ Run ${n} command${n === 1 ? '' : 's'}` : '▶ Run';
  btn.disabled = !n;
}
const planPayload = () => state.c.plan.filter((p) => p.command.trim()).map(({ label, command, cwd, enabled }) => ({ label: label.trim() || command.trim().slice(0, 40), command, cwd, enabled }));

async function savePreset(quiet) {
  const c = state.c;
  try {
    await api('/api/presets', { method: 'POST', body: { repoPath: c.path, processes: planPayload(), target: c.saveTarget } });
    c.info.preset = { source: c.saveTarget, processes: planPayload() };
    if (!quiet) {
      toast('Preset saved');
      renderComposer();
    }
  } catch (e) {
    toast(e.message, true);
  }
}

async function startRun() {
  const c = state.c;
  if (!c.info) return;
  const processes = planPayload();
  if (!processes.some((p) => p.enabled)) return toast('Add at least one command', true);
  if ('Notification' in window && Notification.permission === 'default') Notification.requestPermission().catch(() => {});
  try {
    const r = await api('/api/runs', { method: 'POST', body: { repoPath: c.path, processes, source: 'manual', savePreset: c.save, saveTarget: c.saveTarget } });
    if (c.save) c.info.preset = { source: c.saveTarget, processes };
    navigate(`/run/${r.runId}`);
  } catch (e) {
    toast(e.message, true);
  }
}

/* ================================================================ folder pickers */

async function nativePick() {
  toast('Opening the folder picker… (it may appear behind this window)');
  try {
    const r = await api('/api/pick-folder', { method: 'POST', body: {} });
    if (r.path) await loadRepo(r.path);
  } catch (e) {
    toast(`${e.message} — use “Folders” instead`, true);
  }
}

let fsCurrent = '';
async function openFsDialog(start) {
  const dlg = $('#fsDialog');
  dlg.returnValue = '';
  if (!dlg.open) dlg.showModal();
  await fsGo(start || '');
}
async function fsGo(path) {
  try {
    const r = await api(`/api/fs?path=${encodeURIComponent(path)}`);
    fsCurrent = r.path;
    $('#fsPath').textContent = r.path || 'Locations';
    $('#fsHint').textContent = r.isRepo ? '⎇ git repository' : '';
    $('#fsUse').disabled = !r.path;
    fill($('#fsList'), 
      r.parent != null && h('button', { type: 'button', class: 'fs-item', onClick: () => fsGo(r.parent) }, '↰ ..'),
      ...r.dirs.map((d) => h('button', { type: 'button', class: 'fs-item', onClick: () => fsGo(d.path), onDblclick: () => useFolder(d.path) }, '📁 ', d.name, d.isRepo && h('span', { class: 'chip repo' }, '⎇ repo'))),
      !r.dirs.length && h('div', { class: 'muted', style: 'padding:8px' }, 'No sub-folders'),
    );
  } catch (e) {
    toast(e.message, true);
    // a path typed by hand may not exist — fall back to roots
    if (path) fsGo('');
  }
}
function useFolder(path) {
  $('#fsDialog').close('picked');
  loadRepo(path);
}
$('#fsDialog').addEventListener('close', () => {
  if ($('#fsDialog').returnValue === 'use' && fsCurrent) loadRepo(fsCurrent);
});

/* ================================================================ boot */

connectGlobal();
route();
setInterval(renderSidebar, 30_000); // refresh relative times
