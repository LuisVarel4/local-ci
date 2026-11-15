import { spawn, execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { exists } from './util.mjs';

const isWin = process.platform === 'win32';
const SKIP_DIRS = new Set(['node_modules', 'vendor', '$recycle.bin', 'system volume information', '__pycache__']);

export function openUrl(url) {
  const opts = { detached: true, stdio: 'ignore', windowsHide: true };
  const child = isWin
    ? spawn('rundll32', ['url.dll,FileProtocolHandler', url], opts)
    : spawn(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], opts);
  child.on('error', () => {});
  child.unref();
}

/** List sub-folders of `dir` for the in-app folder browser. Empty dir → roots. */
export async function listDir(dir) {
  if (!dir) {
    const roots = [{ name: 'Home', path: os.homedir() }];
    if (isWin) {
      for (const L of 'CDEFGHIJKLMNOPQRSTUVWXYZ') {
        const d = `${L}:\\`;
        if (await exists(d)) roots.push({ name: `${L}:`, path: d });
      }
    } else roots.push({ name: '/', path: '/' });
    return { path: '', parent: null, dirs: roots.map((r) => ({ ...r, isRepo: false })) };
  }
  const abs = path.resolve(dir);
  const entries = await fs.readdir(abs, { withFileTypes: true });
  const dirs = [];
  for (const e of entries) {
    if (!e.isDirectory() || e.name.startsWith('.') || SKIP_DIRS.has(e.name.toLowerCase())) continue;
    const p = path.join(abs, e.name);
    dirs.push({ name: e.name, path: p, isRepo: await exists(path.join(p, '.git')) });
  }
  dirs.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(abs);
  return {
    path: abs,
    parent: parent === abs ? '' : parent,
    isRepo: await exists(path.join(abs, '.git')),
    dirs,
  };
}

/** Open the OS-native folder picker. Resolves to the chosen path, or null. */
export function pickFolder() {
  return new Promise((resolve) => {
    let cmd;
    let args;
    if (isWin) {
      const ps = [
        '[Console]::OutputEncoding=[Text.Encoding]::UTF8',
        'Add-Type -AssemblyName System.Windows.Forms',
        '$f=New-Object System.Windows.Forms.FolderBrowserDialog',
        "$f.Description='Select a repository folder for Local CI'",
        '$f.ShowNewFolderButton=$false',
        '$o=New-Object System.Windows.Forms.Form -Property @{TopMost=$true}',
        "if($f.ShowDialog($o) -eq 'OK'){[Console]::Out.Write($f.SelectedPath)}",
      ].join(';');
      cmd = 'powershell.exe';
      args = ['-NoProfile', '-STA', '-NonInteractive', '-Command', ps];
    } else if (process.platform === 'darwin') {
      cmd = 'osascript';
      args = ['-e', 'POSIX path of (choose folder with prompt "Select a repository folder for Local CI")'];
    } else {
      cmd = 'zenity';
      args = ['--file-selection', '--directory', '--title=Select a repository folder'];
    }
    execFile(cmd, args, { windowsHide: false, timeout: 10 * 60_000 }, (err, out) => {
      const p = String(out || '').trim();
      resolve(err && !p ? null : p || null);
    });
  });
}
