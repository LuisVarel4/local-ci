#!/usr/bin/env node
import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { PORT, HOST, BASE_URL, PUBLIC_DIR } from './lib/paths.mjs';
import { RunManager } from './lib/runs.mjs';
import { resolveRepo } from './lib/repo.mjs';
import { detectSuggestions, recommendedFrom } from './lib/detect.mjs';
import { getPreset, savePreset, deletePreset, touchRecent, getRecents, forgetRecent, cleanProcesses } from './lib/store.mjs';
import { hookStatus, installHook, uninstallHook } from './lib/hook.mjs';
import { listDir, pickFolder, openUrl } from './lib/system.mjs';
import { HttpError } from './lib/util.mjs';

const runs = new RunManager();
const globalClients = new Set();

/* --------------------------------------------------------------- helpers */

const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.json': 'application/json' };
const allowedHosts = new Set([`127.0.0.1:${PORT}`, `localhost:${PORT}`]);

function guard(req) {
  // DNS-rebinding + CSRF protection: this server can run arbitrary commands.
  if (!allowedHosts.has(req.headers.host)) throw new HttpError(403, 'Forbidden host');
  if (req.headers['sec-fetch-site'] === 'cross-site') throw new HttpError(403, 'Cross-site request blocked');
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    const origin = req.headers.origin;
    if (origin && !allowedHosts.has(origin.replace(/^https?:\/\//, ''))) throw new HttpError(403, 'Forbidden origin');
    if (!String(req.headers['content-type'] || '').includes('application/json')) throw new HttpError(415, 'Send JSON');
  }
}

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}

async function body(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > 1_000_000) throw new HttpError(413, 'Body too large');
    chunks.push(c);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new HttpError(400, 'Invalid JSON');
  }
}

function sseOpen(req, res) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
  res.write('retry: 1500\n\n');
  const ping = setInterval(() => res.write(': ping\n\n'), 20_000);
  req.on('close', () => clearInterval(ping));
}
const sseSend = (res, data) => res.write(`data: ${JSON.stringify(data)}\n\n`);

function broadcast(data) {
  for (const res of globalClients) sseSend(res, data);
}

runs.on('event', (ev) => {
  if (ev.type === 'process.log') return;
  broadcast({ type: 'runs.update', event: ev.type, run: runs.summary(ev.runId) });
});

/* ------------------------------------------------------------ handlers */

async function inspect(repoPath) {
  const repo = await resolveRepo(repoPath);
  const [preset, det, hook] = await Promise.all([getPreset(repo), detectSuggestions(repo), hookStatus(repo)]);
  return {
    repo: { dir: repo.dir, name: repo.name, gitRoot: repo.gitRoot, isGit: repo.isGit, branch: repo.branch },
    preset,
    groups: det.groups,
    techs: det.techs,
    recommended: recommendedFrom(det),
    hook,
  };
}

async function createRun(b) {
  const repo = await resolveRepo(b.repoPath);
  let processes = b.processes;
  let presetSource = 'manual';
  if (!Array.isArray(processes)) {
    const preset = await getPreset(repo);
    if (preset) {
      processes = preset.processes;
      presetSource = preset.source;
    } else {
      processes = recommendedFrom(await detectSuggestions(repo));
      presetSource = 'auto-detected';
    }
  }
  if (b.savePreset && Array.isArray(b.processes)) await savePreset(repo, b.processes, b.saveTarget);
  const toRun = cleanProcesses(processes).filter((p) => p.enabled !== false);
  if (!toRun.length) throw new HttpError(422, `No commands to run for ${repo.dir}`, 'no-commands');

  await touchRecent(repo);
  const run = runs.create({ repo, source: b.source === 'hook' ? 'hook' : 'manual', processes: toRun, presetSource });
  const url = `${BASE_URL}/run/${run.runId}`;
  let opened = 'none';
  if (b.open) {
    if (globalClients.size) {
      broadcast({ type: 'run.focus', runId: run.runId });
      opened = 'focused';
    } else {
      openUrl(url);
      opened = 'browser';
    }
  }
  return { runId: run.runId, url, opened, presetSource, processes: run.processes.map((p) => ({ id: p.id, label: p.label, command: p.command })) };
}

async function route(req, res) {
  guard(req);
  const url = new URL(req.url, BASE_URL);
  const p = url.pathname;
  const m = (re) => p.match(re);
  let r;

  if (p === '/api/health') return json(res, 200, { ok: true, pid: process.pid, port: PORT, platform: process.platform });

  if (p === '/api/shutdown' && req.method === 'POST') {
    json(res, 200, { ok: true });
    runs.stopAll();
    setTimeout(() => process.exit(0), 100);
    return;
  }

  if (p === '/api/events' && req.method === 'GET') {
    sseOpen(req, res);
    globalClients.add(res);
    sseSend(res, { type: 'runs.list', runs: runs.list() });
    req.on('close', () => globalClients.delete(res));
    return;
  }

  if (p === '/api/runs' && req.method === 'GET') return json(res, 200, runs.list());
  if (p === '/api/runs' && req.method === 'POST') return json(res, 201, await createRun(await body(req)));

  if ((r = m(/^\/api\/runs\/([^/]+)$/)) && req.method === 'GET') {
    return json(res, 200, runs.snapshot(runs.get(decodeURIComponent(r[1])), url.searchParams.get('logs') !== '0'));
  }

  if ((r = m(/^\/api\/runs\/([^/]+)\/events$/)) && req.method === 'GET') {
    const runId = decodeURIComponent(r[1]);
    sseOpen(req, res);
    const run = runs.runs.get(runId);
    if (!run) {
      sseSend(res, { type: 'error', status: 404, error: 'Run not found' });
      return res.end();
    }
    sseSend(res, { type: 'snapshot', run: runs.snapshot(run, true) });
    const onEvent = (ev) => ev.runId === runId && sseSend(res, ev);
    runs.on('event', onEvent);
    req.on('close', () => runs.off('event', onEvent));
    return;
  }

  if ((r = m(/^\/api\/runs\/([^/]+)\/stop$/)) && req.method === 'POST') {
    const b = await body(req);
    return json(res, 200, { stopped: runs.stop(decodeURIComponent(r[1]), b.processId) });
  }

  if ((r = m(/^\/api\/runs\/([^/]+)\/rerun$/)) && req.method === 'POST') {
    const b = await body(req);
    const run = runs.get(decodeURIComponent(r[1]));
    if (b.processId) {
      runs.rerunProcess(run.runId, b.processId);
      return json(res, 200, { runId: run.runId });
    }
    const out = await createRun({
      repoPath: run.repoDir,
      source: 'manual',
      processes: run.processes.map((x) => ({ label: x.label, command: x.command, cwd: x.cwdRel })),
    });
    return json(res, 201, out);
  }

  if (p === '/api/inspect' && req.method === 'GET') return json(res, 200, await inspect(url.searchParams.get('path')));

  if (p === '/api/presets' && req.method === 'POST') {
    const b = await body(req);
    const repo = await resolveRepo(b.repoPath);
    if (b.delete) {
      await deletePreset(repo);
      return json(res, 200, { deleted: true });
    }
    return json(res, 200, await savePreset(repo, b.processes, b.target));
  }

  if (p === '/api/recents' && req.method === 'GET') return json(res, 200, await getRecents());
  if (p === '/api/recents/forget' && req.method === 'POST') {
    await forgetRecent((await body(req)).dir || '');
    return json(res, 200, await getRecents());
  }

  if (p === '/api/fs' && req.method === 'GET') {
    try {
      return json(res, 200, await listDir(url.searchParams.get('path') || ''));
    } catch (e) {
      throw new HttpError(400, e.message);
    }
  }
  if (p === '/api/pick-folder' && req.method === 'POST') return json(res, 200, { path: await pickFolder() });

  if ((r = m(/^\/api\/hook\/(install|uninstall)$/)) && req.method === 'POST') {
    const repo = await resolveRepo((await body(req)).repoPath);
    const out = r[1] === 'install' ? await installHook(repo) : await uninstallHook(repo);
    return json(res, 200, { ...out, hook: await hookStatus(repo) });
  }

  if (p.startsWith('/api/')) throw new HttpError(404, 'Not found');

  // static + SPA fallback
  if (req.method !== 'GET' && req.method !== 'HEAD') throw new HttpError(405, 'Method not allowed');
  const rel = path.normalize(decodeURIComponent(p)).replace(/^([/\\])+/, '');
  let file = path.join(PUBLIC_DIR, rel);
  if (!file.startsWith(PUBLIC_DIR) || !path.extname(file)) file = path.join(PUBLIC_DIR, 'index.html');
  try {
    const data = await fs.readFile(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
    res.end(data);
  } catch {
    throw new HttpError(404, 'Not found');
  }
}

/* ---------------------------------------------------------------- boot */

const server = http.createServer((req, res) => {
  route(req, res).catch((e) => {
    const status = e.status || 500;
    if (status === 500) console.error(e);
    if (!res.headersSent) json(res, status, { error: e.message, code: e.code });
    else res.end();
  });
});

server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`[local-ci] port ${PORT} is busy — is the dashboard already running? (${BASE_URL})`);
  else console.error(e);
  process.exit(1);
});

await runs.init();
server.listen(PORT, HOST, () => {
  console.log(`[local-ci] dashboard on ${BASE_URL}`);
  if (process.argv.includes('--open')) openUrl(BASE_URL);
});

for (const sig of ['SIGINT', 'SIGTERM']) {
  process.on(sig, () => {
    runs.stopAll();
    process.exit(0);
  });
}
