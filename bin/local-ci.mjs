#!/usr/bin/env node
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { BASE_URL, SERVER_PATH, SERVER_LOG, HOME_DIR } from '../lib/paths.mjs';
import { resolveRepo } from '../lib/repo.mjs';
import { installHook, uninstallHook, hookStatus } from '../lib/hook.mjs';
import { openUrl } from '../lib/system.mjs';
import { sleep } from '../lib/util.mjs';

const HELP = `local-ci — local parallel CI with a live dashboard

Usage:
  local-ci serve [--open]            start the dashboard server in the foreground
  local-ci open                      start the server in the background (if needed) and open the dashboard
  local-ci stop | status             stop the background server / check whether it is running
  local-ci run [options]             run a folder's commands, wait, exit 0/1 (used by the pre-push hook)
      --repo <dir>                   folder to run in (default: current directory)
      --cmd "<label>=<command>"      ad-hoc command (repeatable); otherwise the folder preset / auto-detected
      --source hook|manual           how the run is labelled (default: manual)
      --no-open                      don't open/focus the dashboard
      --no-wait                      start and return immediately
  local-ci install-hook [dir]        install the git pre-push hook for a repo
  local-ci uninstall-hook [dir]      remove it (restores any hook it backed up)
  local-ci hook-status [dir]

Env: LOCAL_CI_SKIP=1 skips the hook · LOCAL_CI_PORT changes the port (default 7733)
`;

const C = process.stdout.isTTY
  ? { g: (s) => `\x1b[32m${s}\x1b[0m`, r: (s) => `\x1b[31m${s}\x1b[0m`, d: (s) => `\x1b[2m${s}\x1b[0m`, b: (s) => `\x1b[1m${s}\x1b[0m` }
  : { g: (s) => s, r: (s) => s, d: (s) => s, b: (s) => s };
const log = (...a) => console.log('[local-ci]', ...a);
const secs = (ms) => (ms == null ? '' : `${(ms / 1000).toFixed(1)}s`);

async function api(p, { method = 'GET', body } = {}) {
  const res = await fetch(BASE_URL + p, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { code: data.code, status: res.status });
  return data;
}

async function healthy() {
  try {
    const r = await fetch(`${BASE_URL}/api/health`, { signal: AbortSignal.timeout(800) });
    return r.ok;
  } catch {
    return false;
  }
}

async function ensureServer() {
  if (await healthy()) return;
  fs.mkdirSync(HOME_DIR, { recursive: true });
  const out = fs.openSync(SERVER_LOG, 'a');
  const child = spawn(process.execPath, [SERVER_PATH], { detached: true, stdio: ['ignore', out, out], windowsHide: true });
  child.unref();
  for (let i = 0; i < 60; i++) {
    await sleep(150);
    if (await healthy()) return;
  }
  throw new Error(`could not start the dashboard server — see ${SERVER_LOG}`);
}

function parseArgs(argv) {
  const o = { cmds: [], open: true, wait: true, source: 'manual', positional: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--repo') o.repo = argv[++i];
    else if (a === '--cmd') o.cmds.push(argv[++i]);
    else if (a === '--source') o.source = argv[++i];
    else if (a === '--no-open') o.open = false;
    else if (a === '--no-wait') o.wait = false;
    else if (a === '-h' || a === '--help') o.help = true;
    else o.positional.push(a);
  }
  return o;
}

async function cmdRun(o) {
  if (process.env.LOCAL_CI_SKIP) {
    log('LOCAL_CI_SKIP set — skipping');
    return 0;
  }
  const repoPath = path.resolve(o.repo || process.cwd());
  await ensureServer();
  const processes = o.cmds.length
    ? o.cmds.map((c) => {
        const i = c.indexOf('=');
        return i > 0 && !/\s/.test(c.slice(0, i)) ? { label: c.slice(0, i), command: c.slice(i + 1) } : { command: c };
      })
    : undefined;

  let run;
  try {
    run = await api('/api/runs', { method: 'POST', body: { repoPath, source: o.source, processes, open: o.open } });
  } catch (e) {
    if (e.code === 'no-commands') {
      log(`no commands configured for ${repoPath} — nothing to run. Open ${BASE_URL} to set some up.`);
      return 0;
    }
    throw e;
  }
  log(`${C.b(run.processes.length + ' commands')} in parallel (${run.presetSource}) → ${run.url}`);
  for (const p of run.processes) console.log(C.d(`   • ${p.label}: ${p.command}`));
  if (!o.wait) return 0;

  let stopping = false;
  process.on('SIGINT', async () => {
    if (stopping) process.exit(130);
    stopping = true;
    log('stopping run…');
    await api(`/api/runs/${run.runId}/stop`, { method: 'POST', body: {} }).catch(() => {});
  });

  const reported = new Set();
  let snap;
  for (;;) {
    snap = await api(`/api/runs/${run.runId}?logs=0`);
    for (const p of snap.processes) {
      if (reported.has(p.id) || p.status === 'running' || p.status === 'queued') continue;
      reported.add(p.id);
      const mark = p.status === 'passed' ? C.g('✓') : C.r(p.status === 'failed' ? '✗' : '⊘');
      console.log(`   ${mark} ${p.label.padEnd(24)} ${C.d(secs(p.durationMs))}${p.status === 'failed' ? C.r(`  exit ${p.exitCode}`) : ''}`);
    }
    if (snap.status !== 'running') break;
    await sleep(600);
  }

  if (snap.ok) {
    log(C.g(`all passed in ${secs(snap.durationMs)}`));
    return 0;
  }
  const full = await api(`/api/runs/${run.runId}`);
  for (const p of full.processes.filter((x) => x.status === 'failed')) {
    const tail = (p.log || '').replace(/\r/g, '').trimEnd().split('\n').slice(-25).join('\n');
    console.log(`\n${C.r(C.b(`── ${p.label} (exit ${p.exitCode}) ──`))}\n${tail}`);
  }
  log(C.r(`${snap.status} — push blocked. Details: ${run.url}`));
  log(C.d('bypass once with LOCAL_CI_SKIP=1 git push'));
  return 1;
}

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  const o = parseArgs(rest);
  if (!cmd || o.help || cmd === 'help' || cmd === '--help' || cmd === '-h') {
    console.log(HELP);
    return 0;
  }
  switch (cmd) {
    case 'serve':
      process.argv.push(...rest);
      await import('../server.mjs');
      return null; // keep running
    case 'open':
      await ensureServer();
      openUrl(BASE_URL);
      log(`dashboard: ${BASE_URL}`);
      return 0;
    case 'stop':
      if (!(await healthy())) {
        log('dashboard is not running');
        return 0;
      }
      await api('/api/shutdown', { method: 'POST', body: {} });
      log('dashboard stopped');
      return 0;
    case 'status':
      log((await healthy()) ? `running on ${BASE_URL}` : 'not running');
      return 0;
    case 'run':
      return cmdRun(o);
    case 'install-hook': {
      const repo = await resolveRepo(o.positional[0] || o.repo || process.cwd());
      const r = await installHook(repo);
      log(`installed ${r.file}`);
      if (r.backedUp) log(`previous hook saved as ${r.backedUp}${r.chainLfs ? ' (git-lfs, still chained)' : ''}`);
      if (repo.hooksPath) log(C.r(`warning: core.hooksPath=${repo.hooksPath} — tools like husky may overwrite this hook`));
      return 0;
    }
    case 'uninstall-hook': {
      const repo = await resolveRepo(o.positional[0] || o.repo || process.cwd());
      const r = await uninstallHook(repo);
      log(`removed ${r.file}${r.restored ? ' (previous hook restored)' : ''}`);
      return 0;
    }
    case 'hook-status': {
      const repo = await resolveRepo(o.positional[0] || o.repo || process.cwd());
      console.log(await hookStatus(repo));
      return 0;
    }
    default:
      console.error(`unknown command: ${cmd}\n\n${HELP}`);
      return 2;
  }
}

main().then(
  // set exitCode instead of process.exit(): exiting while a fetch socket is closing trips a libuv assertion on Windows
  (code) => code != null && (process.exitCode = code),
  (e) => {
    console.error('[local-ci]', e.message);
    // never block a push because the dashboard itself broke
    process.exit(process.argv.includes('hook') ? 0 : 1);
  },
);
