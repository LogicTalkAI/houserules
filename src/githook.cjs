'use strict';
// A git pre-commit hook that scans staged changes for secrets. It works for every assistant and every person,
// because it runs on commit, not inside any one tool. Respects core.hooksPath and keeps any existing pre-commit hook.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { upsertBlock, removeBlock, hasBlock, readIf } = require('./blocks.cjs');

const BODY = [
  'if command -v node >/dev/null 2>&1; then',
  '  node "$(git rev-parse --show-toplevel)/.houserules/runtime/houserules.cjs" scan --staged || exit 1',
  'else',
  '  echo "House Rules: node was not found, so the secret scan did not run." >&2',
  'fi',
].join('\n');

function hooksDir(root) {
  try {
    const out = execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return path.resolve(root, out);
  } catch { return null; }
}

function install(root, { dryRun = false } = {}) {
  const dir = hooksDir(root);
  if (!dir) return { ok: false, reason: 'not a git repository' };
  const file = path.join(dir, 'pre-commit');
  const cur = readIf(file);
  if (cur != null && hasBlock(cur, 'hash')) {
    const next = upsertBlock(cur, BODY, 'hash', 'top');
    if (next.replace(/\r\n/g, '\n') === cur.replace(/\r\n/g, '\n')) return { ok: true, changed: false, file };
  }
  const base = cur == null ? '#!/bin/sh\n' : cur;
  const next = upsertBlock(base, BODY, 'hash', 'top');
  if (!dryRun) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, next.replace(/\r\n/g, '\n'));
    try { fs.chmodSync(file, 0o755); } catch { /* Windows: git for Windows runs hooks through sh regardless */ }
  }
  return { ok: true, changed: true, file };
}

function uninstall(root) {
  const dir = hooksDir(root);
  if (!dir) return { ok: false };
  const file = path.join(dir, 'pre-commit');
  const cur = readIf(file);
  if (cur == null || !hasBlock(cur, 'hash')) return { ok: true, changed: false };
  const next = removeBlock(cur, 'hash');
  if (!next.replace(/^#!.*\n?/, '').trim()) fs.unlinkSync(file); else fs.writeFileSync(file, next);
  return { ok: true, changed: true, file };
}

function status(root) {
  const dir = hooksDir(root);
  if (!dir) return { installed: false, reason: 'not a git repository' };
  const cur = readIf(path.join(dir, 'pre-commit'));
  return { installed: !!cur && hasBlock(cur, 'hash'), file: path.join(dir, 'pre-commit') };
}

module.exports = { install, uninstall, status, hooksDir };
