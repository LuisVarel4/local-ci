import fs from 'node:fs/promises';

export class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function readText(p) {
  try {
    return await fs.readFile(p, 'utf8');
  } catch {
    return null;
  }
}

export async function readJson(p) {
  const t = await readText(p);
  if (t == null) return null;
  try {
    return JSON.parse(t.replace(/^﻿/, ''));
  } catch {
    return null;
  }
}

export async function exists(p) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

export const slugify = (s) =>
  String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);

export const toPosix = (p) => String(p).replace(/\\/g, '/');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
