import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const HOME_DIR = process.env.LOCAL_CI_HOME || path.join(os.homedir(), '.local-ci');
export const RUNS_DIR = path.join(HOME_DIR, 'runs');
export const STORE_FILE = path.join(HOME_DIR, 'store.json');
export const SERVER_LOG = path.join(HOME_DIR, 'server.log');
export const PORT = Number(process.env.LOCAL_CI_PORT) || 7733;
export const HOST = '127.0.0.1';
export const BASE_URL = `http://${HOST}:${PORT}`;
export const SERVER_PATH = path.join(APP_ROOT, 'server.mjs');
export const BIN_PATH = path.join(APP_ROOT, 'bin', 'local-ci.mjs');
export const PUBLIC_DIR = path.join(APP_ROOT, 'public');
