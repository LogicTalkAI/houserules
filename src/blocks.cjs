'use strict';
// Writes House Rules content into files people also edit by hand (AGENTS.md, CLAUDE.md, copilot-instructions.md, ...)
// without touching anything outside its own marked block. Running it twice changes nothing; uninstall removes only the block.
const fs = require('fs');
const path = require('path');

const MARKS = {
  md: ['<!-- houserules:begin (generated from .houserules/, edit there and run `houserules sync`) -->', '<!-- houserules:end -->'],
  hash: ['# houserules:begin (generated from .houserules/, edit there and run `houserules sync`)', '# houserules:end'],
};
const BEGIN_RE = { md: /<!-- houserules:begin[^>]*-->/, hash: /^# houserules:begin.*$/m };
const END_RE = { md: /<!-- houserules:end -->/, hash: /^# houserules:end$/m };

// position "top" puts a new block first (CLAUDE.md imports, TOML keys that must come before any [table]).
function upsertBlock(text, body, style = 'md', position = 'bottom') {
  const [b, e] = MARKS[style];
  const block = `${b}\n${body.trim()}\n${e}`;
  const src = (text || '').replace(/\r\n/g, '\n');
  const bm = src.match(BEGIN_RE[style]), em = src.match(END_RE[style]);
  if (bm && em && em.index > bm.index) return src.slice(0, bm.index) + block + src.slice(em.index + em[0].length);
  if (!src.trim()) return block + '\n';
  if (position === 'top') {
    const shebang = src.startsWith('#!') ? src.slice(0, src.indexOf('\n') + 1) : '';
    return shebang + block + '\n\n' + src.slice(shebang.length).replace(/^\s*/, '');
  }
  return src.replace(/\s*$/, '') + '\n\n' + block + '\n';
}

function removeBlock(text, style = 'md') {
  const src = (text || '').replace(/\r\n/g, '\n');
  const bm = src.match(BEGIN_RE[style]), em = src.match(END_RE[style]);
  if (!(bm && em && em.index > bm.index)) return src;
  const out = (src.slice(0, bm.index).replace(/\s*$/, '') + '\n' + src.slice(em.index + em[0].length).replace(/^\s*/, '')).trim();
  return out ? out + '\n' : '';
}

function hasBlock(text, style = 'md') { return BEGIN_RE[style].test(text || '') && END_RE[style].test(text || ''); }

function readIf(file) { try { return fs.readFileSync(file, 'utf8'); } catch { return null; } }

// Only writes when the content changes, and keeps the file's line endings.
function writeIfChanged(file, content) {
  const old = readIf(file);
  const eol = old && old.includes('\r\n') ? '\r\n' : '\n';
  const next = content.replace(/\r?\n/g, eol);
  if (old === next) return false;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return true;
}

module.exports = { upsertBlock, removeBlock, hasBlock, readIf, writeIfChanged, MARKS };
