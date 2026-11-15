import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { StringDecoder } from 'node:string_decoder';
import { existsSync } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { RUNS_DIR } from './paths.mjs';
import { slugify, HttpError } from './util.mjs';

const MAX_LOG_CHARS = 1_500_000; // per process, oldest output is dropped beyond this
const KEEP_IN_MEMORY = 60;
const KEEP_ON_DISK = 200;
const isWin = process.platform === 'win32';

const newRunId = () =>
  new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6);

const isActive = (s) => s === 'running' || s === 'queued';

function procView(p, withLogs) {
  const v = {
    id: p.id,
    label: p.label,
    command: p.command,
    cwd: p.cwd,
    cwdRel: p.cwdRel,
    status: p.status,
    pid: p.pid,
    exitCode: p.exitCode,
    startedAt: p.startedAt,
    durationMs: p.durationMs,
    attempt: p.attempt,
    truncated: p.truncated,
  };
  if (withLogs) v.log = p.log.map((x) => x[1]).join('');
  return v;
}

function killTree(child) {
  if (!child || child.exitCode !== null) return;
  if (isWin) {
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {});
  } else {
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {
      child.kill('SIGTERM');
    }
  }
}

export class RunManager extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(0);
    this.runs = new Map();
    this.children = new Map();
  }

  async init() {
    await fs.mkdir(RUNS_DIR, { recursive: true });
    const files = (await fs.readdir(RUNS_DIR)).filter((f) => f.endsWith('.json')).sort().reverse();
    for (const f of files.slice(KEEP_ON_DISK)) fs.unlink(path.join(RUNS_DIR, f)).catch(() => {});
    for (const f of files.slice(0, KEEP_IN_MEMORY).reverse()) {
      try {
        const run = JSON.parse(await fs.readFile(path.join(RUNS_DIR, f), 'utf8'));
        if (run.status === 'running') run.status = 'interrupted';
        for (const p of run.processes) {
          if (isActive(p.status)) p.status = 'interrupted';
          p.log = [[0, p.log || '']];
          p.logChars = p.log[0][1].length;
        }
        this.runs.set(run.runId, run);
      } catch {
        /* ignore corrupt history */
      }
    }
  }

  get(runId) {
    const run = this.runs.get(runId);
    if (!run) throw new HttpError(404, `Run not found: ${runId}`);
    return run;
  }

  list() {
    return [...this.runs.values()]
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((r) => this.summary(r));
  }

  summary(run) {
    if (typeof run === 'string') run = this.runs.get(run);
    if (!run) return null;
    return {
      runId: run.runId,
      repoDir: run.repoDir,
      repoName: run.repoName,
      gitRoot: run.gitRoot,
      branch: run.branch,
      source: run.source,
      presetSource: run.presetSource,
      status: run.status,
      ok: run.ok,
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
      durationMs: run.durationMs,
      processes: run.processes.map((p) => ({ id: p.id, label: p.label, status: p.status })),
    };
  }

  snapshot(run, withLogs = true) {
    return { ...this.summary(run), processes: run.processes.map((p) => procView(p, withLogs)) };
  }

  emitEvent(ev) {
    this.emit('event', ev);
  }

  create({ repo, source, processes, presetSource }) {
    const used = new Set();
    const procs = processes.map((p, i) => {
      const label = String(p.label || p.command).trim().slice(0, 60);
      const base = slugify(p.id || label) || `step-${i + 1}`;
      let id = base;
      for (let n = 2; used.has(id); n++) id = `${base}-${n}`;
      used.add(id);
      const cwdRel = String(p.cwd || '').trim();
      return {
        id,
        label,
        command: String(p.command).trim(),
        cwd: cwdRel ? path.resolve(repo.dir, cwdRel) : repo.dir,
        cwdRel,
        status: 'queued',
        pid: null,
        exitCode: null,
        startedAt: null,
        durationMs: null,
        attempt: 0,
        log: [],
        logChars: 0,
        truncated: false,
      };
    });
    const run = {
      runId: newRunId(),
      repoDir: repo.dir,
      repoName: repo.name,
      gitRoot: repo.gitRoot,
      branch: repo.branch,
      source,
      presetSource: presetSource || null,
      status: 'running',
      ok: null,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      durationMs: null,
      processes: procs,
    };
    this.runs.set(run.runId, run);
    this.prune();
    this.emitEvent({ type: 'run.started', runId: run.runId, run: this.snapshot(run, false) });
    for (const p of procs) this.startProcess(run, p);
    return run;
  }

  startProcess(run, p) {
    const key = `${run.runId}\0${p.id}`;
    Object.assign(p, {
      status: 'running',
      exitCode: null,
      durationMs: null,
      startedAt: new Date().toISOString(),
      pid: null,
      log: [],
      logChars: 0,
      truncated: false,
      cancelled: false,
    });
    p.attempt++;
    if (run.status !== 'running') {
      Object.assign(run, { status: 'running', ok: null, finishedAt: null, durationMs: null });
      this.emitEvent({ type: 'run.resumed', runId: run.runId });
    }
    const t0 = Date.now();
    let child;
    try {
      if (!existsSync(p.cwd)) throw new Error(`working directory not found: ${p.cwd}`);
      child = spawn(p.command, {
        cwd: p.cwd,
        shell: true,
        windowsHide: true,
        detached: !isWin,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          FORCE_COLOR: process.env.FORCE_COLOR ?? '1',
          CI: process.env.CI ?? 'true',
          LOCAL_CI: '1',
        },
      });
    } catch (e) {
      this.emitEvent({ type: 'process.started', runId: run.runId, processId: p.id, pid: null, attempt: p.attempt, startedAt: p.startedAt });
      this.appendLog(run, p, 'stderr', `[local-ci] failed to start: ${e.message}\n`);
      this.finishProcess(run, p, -1, t0);
      return;
    }
    p.pid = child.pid ?? null;
    this.children.set(key, child);
    this.emitEvent({ type: 'process.started', runId: run.runId, processId: p.id, pid: p.pid, attempt: p.attempt, startedAt: p.startedAt });

    for (const stream of ['stdout', 'stderr']) {
      const dec = new StringDecoder('utf8');
      child[stream].on('data', (b) => this.appendLog(run, p, stream, dec.write(b)));
      child[stream].on('end', () => {
        const rest = dec.end();
        if (rest) this.appendLog(run, p, stream, rest);
      });
    }
    let done = false;
    const finish = (code, msg) => {
      if (done) return;
      done = true;
      this.children.delete(key);
      if (msg) this.appendLog(run, p, 'stderr', msg);
      this.finishProcess(run, p, code, t0);
    };
    child.on('error', (e) => finish(-1, `\n[local-ci] ${e.message}\n`));
    child.on('close', (code, signal) =>
      finish(code ?? 1, signal && !p.cancelled ? `\n[local-ci] terminated by ${signal}\n` : null),
    );
  }

  appendLog(run, p, stream, chunk) {
    if (!chunk) return;
    p.log.push([stream === 'stderr' ? 1 : 0, chunk]);
    p.logChars += chunk.length;
    while (p.logChars > MAX_LOG_CHARS && p.log.length > 1) {
      p.logChars -= p.log.shift()[1].length;
      p.truncated = true;
    }
    this.emitEvent({ type: 'process.log', runId: run.runId, processId: p.id, stream, chunk });
  }

  finishProcess(run, p, code, t0) {
    p.exitCode = code;
    p.durationMs = Date.now() - t0;
    p.status = p.cancelled ? 'cancelled' : code === 0 ? 'passed' : 'failed';
    this.emitEvent({
      type: 'process.exited',
      runId: run.runId,
      processId: p.id,
      exitCode: code,
      status: p.status,
      durationMs: p.durationMs,
    });
    this.checkRun(run);
  }

  checkRun(run) {
    if (run.processes.some((p) => isActive(p.status))) return;
    const st = run.processes.map((p) => p.status);
    run.status = st.every((s) => s === 'passed') ? 'passed' : st.includes('failed') ? 'failed' : 'cancelled';
    run.ok = run.status === 'passed';
    run.finishedAt = new Date().toISOString();
    run.durationMs = Date.parse(run.finishedAt) - Date.parse(run.startedAt);
    this.emitEvent({ type: 'run.finished', runId: run.runId, ok: run.ok, status: run.status, durationMs: run.durationMs });
    this.persist(run);
  }

  stop(runId, processId) {
    const run = this.get(runId);
    let n = 0;
    for (const p of run.processes) {
      if (processId && p.id !== processId) continue;
      const child = this.children.get(`${run.runId}\0${p.id}`);
      if (p.status === 'running' && child) {
        p.cancelled = true;
        killTree(child);
        n++;
      }
    }
    return n;
  }

  rerunProcess(runId, processId) {
    const run = this.get(runId);
    const p = run.processes.find((x) => x.id === processId);
    if (!p) throw new HttpError(404, `Process not found: ${processId}`);
    if (isActive(p.status)) throw new HttpError(409, `${p.label} is still running`);
    this.startProcess(run, p);
  }

  prune() {
    const sorted = [...this.runs.values()].sort((a, b) => a.startedAt.localeCompare(b.startedAt));
    while (sorted.length > KEEP_IN_MEMORY) {
      const r = sorted.shift();
      if (r.status === 'running') continue;
      this.runs.delete(r.runId);
    }
  }

  async persist(run) {
    try {
      await fs.mkdir(RUNS_DIR, { recursive: true });
      await fs.writeFile(path.join(RUNS_DIR, `${run.runId}.json`), JSON.stringify(this.snapshot(run, true)));
    } catch (e) {
      console.error('[local-ci] could not persist run', e.message);
    }
  }

  stopAll() {
    for (const child of this.children.values()) killTree(child);
  }
}
