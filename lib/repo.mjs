import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { HttpError } from './util.mjs';

function git(cwd, args) {
  return new Promise((resolve) =>
    execFile('git', args, { cwd, windowsHide: true, timeout: 5000 }, (err, out) => resolve(err ? null : out.trim())),
  );
}

/**
 * Resolve a user-supplied folder. `dir` is the folder commands run in (may be a
 * sub-package of a monorepo); `gitRoot` is the enclosing repository, if any.
 */
export async function resolveRepo(input) {
  const raw = String(input || '').trim().replace(/^["']|["']$/g, '');
  if (!raw) throw new HttpError(400, 'Choose a folder first');
  const dir = path.resolve(raw);
  const st = await fs.stat(dir).catch(() => null);
  if (!st || !st.isDirectory()) throw new HttpError(400, `Folder not found: ${dir}`);

  const top = await git(dir, ['rev-parse', '--show-toplevel']);
  const gitRoot = top ? path.resolve(top) : null;
  let branch = null;
  let hooksDir = null;
  let hooksPath = null;
  if (gitRoot) {
    branch = await git(gitRoot, ['rev-parse', '--abbrev-ref', 'HEAD']);
    const hp = await git(gitRoot, ['rev-parse', '--git-path', 'hooks']);
    hooksDir = hp ? path.resolve(gitRoot, hp) : path.join(gitRoot, '.git', 'hooks');
    hooksPath = await git(gitRoot, ['config', '--get', 'core.hooksPath']);
  }
  const name = gitRoot && gitRoot !== dir
    ? `${path.basename(gitRoot)}/${path.relative(gitRoot, dir).replace(/\\/g, '/')}`
    : path.basename(dir);

  return { dir, name, gitRoot, isGit: !!gitRoot, branch, hooksDir, hooksPath: hooksPath || null };
}
