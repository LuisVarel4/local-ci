import fs from 'node:fs/promises';
import path from 'node:path';
import { HOME_DIR, STORE_FILE } from './paths.mjs';
import { readJson } from './util.mjs';

/**
 * Presets (the list of commands for a folder) can live in three places, checked in order:
 *   1. <folder>/.local-ci.json             (repo file — commit it if the team wants it)
 *   2. ~/.local-ci/store.json              (this machine only — default)
 *   3. <git hooks dir>/pre-push-ci.json    (legacy prototype config from the spec)
 */
export const REPO_PRESET_FILE = '.local-ci.json';

let cache = null;
const keyOf = (dir) => (process.platform === 'win32' ? dir.toLowerCase() : dir).replace(/\\/g, '/');

async function load() {
  if (cache) return cache;
  cache = (await readJson(STORE_FILE)) || {};
  cache.recents ||= [];
  cache.presets ||= {};
  return cache;
}

async function save() {
  await fs.mkdir(HOME_DIR, { recursive: true });
  await fs.writeFile(STORE_FILE, JSON.stringify(cache, null, 2));
}

export function cleanProcesses(list) {
  return (Array.isArray(list) ? list : [])
    .filter((p) => p && String(p.command || '').trim())
    .map((p) => {
      const o = { label: String(p.label || p.command).trim().slice(0, 60), command: String(p.command).trim() };
      if (p.id) o.id = String(p.id);
      if (p.cwd && String(p.cwd).trim() && String(p.cwd).trim() !== '.') o.cwd = String(p.cwd).trim();
      if (p.enabled === false) o.enabled = false;
      return o;
    });
}

export async function getPreset(repo) {
  const repoFile = path.join(repo.dir, REPO_PRESET_FILE);
  const fromRepo = await readJson(repoFile);
  if (fromRepo?.processes?.length) {
    return { source: 'repo', file: repoFile, processes: cleanProcesses(fromRepo.processes) };
  }
  const s = await load();
  const mine = s.presets[keyOf(repo.dir)];
  if (mine?.processes?.length) {
    return { source: 'user', file: STORE_FILE, processes: cleanProcesses(mine.processes), updatedAt: mine.updatedAt };
  }
  if (repo.hooksDir) {
    const legacyFile = path.join(repo.hooksDir, 'pre-push-ci.json');
    const legacy = await readJson(legacyFile);
    if (legacy?.processes?.length) {
      return { source: 'legacy', file: legacyFile, processes: cleanProcesses(legacy.processes) };
    }
  }
  return null;
}

export async function savePreset(repo, processes, target = 'user') {
  const clean = cleanProcesses(processes);
  if (target === 'repo') {
    const file = path.join(repo.dir, REPO_PRESET_FILE);
    const prev = (await readJson(file)) || {};
    await fs.writeFile(file, JSON.stringify({ ...prev, processes: clean }, null, 2) + '\n');
    return { source: 'repo', file };
  }
  const s = await load();
  s.presets[keyOf(repo.dir)] = { dir: repo.dir, processes: clean, updatedAt: new Date().toISOString() };
  await save();
  return { source: 'user', file: STORE_FILE };
}

export async function deletePreset(repo) {
  const s = await load();
  delete s.presets[keyOf(repo.dir)];
  await save();
}

export async function touchRecent(repo) {
  const s = await load();
  const k = keyOf(repo.dir);
  s.recents = [
    { dir: repo.dir, name: repo.name, lastUsed: new Date().toISOString() },
    ...s.recents.filter((r) => keyOf(r.dir) !== k),
  ].slice(0, 12);
  await save();
}

export async function getRecents() {
  return (await load()).recents;
}

export async function forgetRecent(dir) {
  const s = await load();
  s.recents = s.recents.filter((r) => keyOf(r.dir) !== keyOf(dir));
  await save();
}
