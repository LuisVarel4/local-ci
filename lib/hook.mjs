import fs from 'node:fs/promises';
import path from 'node:path';
import { BIN_PATH } from './paths.mjs';
import { readText, exists, toPosix, HttpError } from './util.mjs';

export const HOOK_MARK = '# >>> local-ci managed hook';
const BACKUP_SUFFIX = '.local-ci-backup';

function hookFile(repo) {
  if (!repo.hooksDir) throw new HttpError(400, 'Not a git repository — hooks need a git repo');
  return path.join(repo.hooksDir, 'pre-push');
}

export async function hookStatus(repo) {
  if (!repo.hooksDir) return { supported: false };
  const file = hookFile(repo);
  const txt = await readText(file);
  return {
    supported: true,
    file,
    installed: !!txt && txt.includes(HOOK_MARK),
    otherHook: !!txt && !txt.includes(HOOK_MARK),
    hasBackup: await exists(file + BACKUP_SUFFIX),
    hooksPath: repo.hooksPath,
  };
}

function script(repo, chainLfs) {
  const node = toPosix(process.execPath);
  const bin = toPosix(BIN_PATH);
  const repoArg = repo.dir === repo.gitRoot ? '"$(git rev-parse --show-toplevel)"' : `"${toPosix(repo.dir)}"`;
  const lfs = chainLfs
    ? `\n# keep git-lfs working: run the previous hook (it needs stdin) before local-ci\nsh "$(dirname "$0")/pre-push${BACKUP_SUFFIX}" "$@" || exit $?\n`
    : '';
  return `#!/bin/sh
${HOOK_MARK} (installed ${new Date().toISOString()})
# Runs your Local CI commands in parallel, opens the dashboard and blocks the push if any fails.
# Skip once:  LOCAL_CI_SKIP=1 git push        Remove:  node "${bin}" uninstall-hook
${lfs}
NODE="${node}"
[ -x "$NODE" ] || NODE=node
exec "$NODE" "${bin}" run --repo ${repoArg} --source hook
`;
}

export async function installHook(repo) {
  const file = hookFile(repo);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const current = await readText(file);
  let backedUp = null;
  let chainLfs = false;
  if (current && !current.includes(HOOK_MARK)) {
    backedUp = file + BACKUP_SUFFIX;
    if (await exists(backedUp)) backedUp = `${file}${BACKUP_SUFFIX}-${Date.now()}`;
    await fs.rename(file, backedUp);
    chainLfs = /git[ -]lfs/.test(current) && backedUp === file + BACKUP_SUFFIX;
  }
  await fs.writeFile(file, script(repo, chainLfs), { mode: 0o755 });
  await fs.chmod(file, 0o755).catch(() => {});
  return { file, backedUp, chainLfs };
}

export async function uninstallHook(repo) {
  const file = hookFile(repo);
  const current = await readText(file);
  if (!current || !current.includes(HOOK_MARK)) throw new HttpError(409, 'The pre-push hook is not managed by local-ci');
  await fs.unlink(file);
  const backup = file + BACKUP_SUFFIX;
  let restored = false;
  if (await exists(backup)) {
    await fs.rename(backup, file);
    restored = true;
  }
  return { file, restored };
}
