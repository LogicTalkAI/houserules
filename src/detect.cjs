'use strict';
// Which assistants are installed on this computer (for `doctor`). Looks on PATH only; runs nothing.
const fs = require('fs');
const path = require('path');

const COMMANDS = {
  claude: ['claude'],
  codex: ['codex'],
  copilot: ['copilot', 'gh'],
  cursor: ['cursor', 'cursor-agent'],
  gemini: ['gemini'],
  grok: ['grok'],
  vscode: ['code', 'code-insiders'],
};

function onPath(name) {
  const dirs = String(process.env.PATH || '').split(path.delimiter).filter(Boolean);
  const exts = process.platform === 'win32' ? String(process.env.PATHEXT || '.EXE;.CMD;.BAT;.COM').split(';').concat(['']) : [''];
  for (const d of dirs) for (const e of exts) {
    const p = path.join(d, name + e.toLowerCase());
    const P = path.join(d, name + e);
    try { if (fs.statSync(p).isFile() || fs.statSync(P).isFile()) return true; } catch { /* keep looking */ }
  }
  return false;
}

function detect() {
  const out = {};
  for (const [tool, names] of Object.entries(COMMANDS)) out[tool] = names.find(onPath) || null;
  return out;
}

module.exports = { detect, onPath, COMMANDS };
