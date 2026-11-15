# Local pre-push CI dashboard (future build)

Personal / local-only plan. Goal: when a `pre-push` hook runs (terminal, Cursor, or GitKraken), open a localhost UI that shows each CI command in its own tab, running in parallel, with live output. The UI should discover processes dynamically from the hook instead of hardcoding step names in the frontend.

This file is under `docs/` (gitignored in this repo) so it stays local.

---

## 1. Product goals

| Goal | Detail |
|------|--------|
| Parallel runs | oxlint, eslint, type-check, vitest (and any future steps) start together |
| One tab per process | Each command has its own tab with scrolling live logs |
| Open on pre-push | Hook starts (or wakes) the dashboard and opens the browser/WebView |
| Dynamic discovery | UI renders whatever processes the runner registers — no hardcoded step list in the UI |
| Block the push | Hook waits for all processes; non-zero exit still blocks `git push` |
| Local only | Bind to `127.0.0.1`, no auth, no cloud, optional gitignore of runner config |

---

## 2. High-level architecture

```
git pre-push
    │
    ├─► ensure local CI server is up (localhost:7xxx)
    ├─► open http://127.0.0.1:7xxx/run/<runId>
    │
    └─► CI runner
            ├─ registers run + process list (dynamic)
            ├─ spawns each command in parallel
            ├─ streams stdout/stderr per process (SSE or WebSocket)
            └─ reports final exit codes → hook exits 0/1
```

**Three pieces**

1. **Hook adapter** — thin `.git/hooks/pre-push` that calls the runner and opens the UI  
2. **Local CI server + runner** — owns process lifecycle, status, and log streams  
3. **Dashboard UI** — tabs, status chips, log panes; driven only by server events  

---

## 3. Suggested stack (Windows-friendly)

Keep it boring and easy to maintain:

| Layer | Suggestion | Why |
|-------|------------|-----|
| Server | Node (Express/Hono/Fastify) or plain `node:http` | Same toolchain as the FE repo |
| Realtime | Server-Sent Events (SSE) first; WebSocket if needed | Simple one-way log streaming |
| UI | Vite + Vue (or plain HTML) | Matches this repo; fast to prototype |
| Process spawn | `child_process.spawn` with `shell: true` on Windows | Correct PATH / `pnpm` resolution |
| Persistence | Optional JSONL under `%TEMP%\fasil-prepush\` | Debug past runs; not required for v1 |

Optional later: wrap the UI in **Tauri** as a tray app that embeds the same localhost page.

---

## 4. Dynamic process model

Do **not** hardcode `['oxlint','eslint',…]` in the UI.

### 4.1 Process manifest (runner → server)

When a run starts, the runner POSTs (or writes) a manifest:

```json
{
  "runId": "2026-11-12T23-01-00Z-a1b2",
  "repoRoot": "C:/Users/.../fasil-web-2.0",
  "startedAt": "2026-11-12T23:01:00.123Z",
  "processes": [
    {
      "id": "oxlint",
      "label": "oxlint",
      "command": "pnpm exec oxlint .",
      "cwd": "<repoRoot>"
    },
    {
      "id": "eslint",
      "label": "eslint",
      "command": "pnpm exec eslint . --cache",
      "cwd": "<repoRoot>"
    }
  ]
}
```

Add/remove/rename steps only in the **runner config** (see §6). The UI always:

1. Creates one tab per `processes[]` entry  
2. Subscribes to events keyed by `process.id`  
3. Shows whatever labels the manifest provides  

### 4.2 Event stream (server → UI)

Examples:

```json
{ "type": "run.started", "runId": "…", "processes": [/* same as manifest */] }
{ "type": "process.started", "runId": "…", "processId": "oxlint", "pid": 12345 }
{ "type": "process.log", "runId": "…", "processId": "oxlint", "stream": "stdout", "chunk": "…" }
{ "type": "process.exited", "runId": "…", "processId": "oxlint", "exitCode": 0, "durationMs": 4200 }
{ "type": "run.finished", "runId": "…", "ok": true, "durationMs": 51000 }
```

UI rules:

- On `run.started` → rebuild tabs from `processes` (dynamic)  
- On `process.log` → append to that tab’s buffer  
- On `process.exited` → tab badge green/red  
- On `run.finished` → global banner; optional auto-close timer on success  

---

## 5. UI breakdown (tabs + parallel feel)

### 5.1 Layout

```
┌─────────────────────────────────────────────────────────┐
│  Pre-push CI · fasil-web-2.0     RUNNING  12s           │
│  [All] [oxlint ✓] [eslint …] [type-check …] [tests …]   │  ← dynamic tabs
├─────────────────────────────────────────────────────────┤
│  live log for selected process (monospace, auto-scroll) │
│  …                                                      │
├─────────────────────────────────────────────────────────┤
│  Summary: 1 passed · 3 running · 0 failed               │
└─────────────────────────────────────────────────────────┘
```

### 5.2 Tab behavior

- **One tab per process** from the manifest  
- Optional **All** tab: multiplexed logs with a prefix (`[eslint] …`)  
- Badge per tab: queued / running / pass / fail  
- Selecting a tab does not pause other processes (they keep running in the background)  
- Preserve scroll position per tab; “Follow” toggle for auto-scroll  

### 5.3 UX extras (later)

- Click failed tab first when any process fails  
- Copy log / open log file  
- Re-run single process (dev convenience; pre-push should still use a full gate)  
- Dark theme, keyboard shortcuts (`1…9` switch tabs)  

---

## 6. Runner config (source of truth for processes)

Keep a local config the hook/runner reads, e.g. `%USERPROFILE%\.fasil\pre-push-ci.json` or `.git/hooks/pre-push-ci.json`:

```json
{
  "port": 7733,
  "openBrowser": true,
  "processes": [
    { "id": "oxlint", "label": "oxlint", "command": "pnpm exec oxlint ." },
    { "id": "eslint", "label": "eslint", "command": "pnpm exec eslint . --cache" },
    { "id": "types", "label": "type-check", "command": "pnpm type-check" },
    { "id": "tests", "label": "unit tests", "command": "pnpm vitest run --reporter=dot" }
  ]
}
```

Changing this file changes what the UI shows on the next push — **no UI redeploy** if the dashboard is fully event-driven.

---

## 7. Pre-push integration

Replace / extend the current PowerShell monitor with:

```text
pre-push
  1. resolve repo root
  2. start CI server if not listening on 127.0.0.1:PORT
  3. POST /api/runs  → { runId, processes from config }
  4. open http://127.0.0.1:PORT/run/{runId}
  5. wait until GET /api/runs/{runId} → status finished
  6. exit with run.ok ? 0 : 1
```

### 7.1 Opening the app

- `Start-Process` the default browser to the run URL (works from GitKraken / Cursor / terminal)  
- Or open Edge/Chrome app mode: `--app=http://127.0.0.1:PORT/run/...` for a cleaner window  
- Later: Tauri window instead of browser  

### 7.2 Server lifetime

- **Option A:** start per push, shut down after run (simpler)  
- **Option B:** keep a background server/tray app always on (faster open, more moving parts)  

Recommend **A** for v1.

---

## 8. Implementation phases

### Phase 0 — Spec freeze
- [ ] Finalize event schema (`run.*` / `process.*`)  
- [ ] Decide port + config path  
- [ ] Decide browser vs `--app` window  

### Phase 1 — Runner + API only
- [ ] Node script: load config, spawn processes in parallel  
- [ ] HTTP: create run, stream events, query status  
- [ ] CLI: `node prepush-ci.mjs` exits 0/1 (no UI yet)  
- [ ] Wire `.git/hooks/pre-push` to the CLI  

### Phase 2 — Dashboard UI
- [ ] Vite page: connect to SSE for `runId`  
- [ ] Build tabs dynamically from `run.started`  
- [ ] Render per-process logs  
- [ ] Global pass/fail banner  

### Phase 3 — Hook polish
- [ ] Auto-open browser/app window on push  
- [ ] Success: brief delay then close / leave tab  
- [ ] Failure: focus first failed tab; keep window until dismissed  
- [ ] Ensure GitKraken / Cursor / terminal all block on non-zero exit  

### Phase 4 — Nice-to-haves
- [ ] “All” multiplex tab  
- [ ] History of last N runs in `%TEMP%`  
- [ ] Tauri tray icon (idle / running / red / green)  
- [ ] Single-step re-run for local debugging  

---

## 9. Parallelism notes

- Spawn all configured processes immediately after `run.started`  
- Do not wait for oxlint before eslint, etc.  
- Aggregate: `ok = every process.exitCode === 0`  
- Cap log buffer per process in memory (e.g. last 2000 lines) to avoid huge vitest output freezing the UI  
- On Windows, prefer `spawn(command, { shell: true, cwd: repoRoot })` so `pnpm` resolves like an interactive shell  

---

## 10. Security / scope (local)

- Listen only on `127.0.0.1`  
- No remote access, no auth (local trust boundary)  
- Do not commit the dashboard app into the shared repo unless the team wants it — keep under `.git/hooks/`, `%USERPROFILE%\.fasil\`, or a personal folder  
- Never print secrets; treat logs like CI logs  

---

## 11. Acceptance checklist (when built)

- [ ] `git push` opens the dashboard automatically  
- [ ] All configured commands start in parallel  
- [ ] Each command has its own tab with live output  
- [ ] Adding a process in config appears as a new tab without UI code changes  
- [ ] Failed step turns its tab red and overall run fails  
- [ ] Push is blocked when any process fails  
- [ ] Works from terminal, Cursor, and GitKraken on Windows  

---

## 12. Out of scope (for this idea)

- Replacing GitHub Actions remote CI  
- Sharing the dashboard with the team by default  
- E2E / Playwright in the same gate (can be added later via config)  
- Editing commands from the UI (config file remains source of truth)  

---

## 13. Starting point from today

Current local pieces to reuse / replace later:

- `.git/hooks/pre-push` — entrypoint  
- `.git/hooks/pre-push-ci.ps1` — parallel runner + PowerShell window (prototype UX)  

Future work should move process orchestration + streaming into the Node server, and keep the hook as a thin launcher that only starts the run and opens the dashboard URL.
