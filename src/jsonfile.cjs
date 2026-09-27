'use strict';
// Reads and edits JSON settings files that people also edit by hand. Never rewrites a file it cannot parse,
// and never rewrites a file that contains comments (VS Code JSONC), because that would delete the comments.
const fs = require('fs');

function hasComments(text) {
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inStr) { if (c === '\\') i++; else if (c === '"') inStr = false; continue; }
    if (c === '"') inStr = true;
    else if (c === '/' && (text[i + 1] === '/' || text[i + 1] === '*')) return true;
  }
  return false;
}

// Returns { data, raw, ok, reason }. A missing file is ok with empty data.
function readJsonFile(file) {
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return { data: {}, raw: null, ok: true }; }
  const clean = raw.replace(/^﻿/, '');
  if (!clean.trim()) return { data: {}, raw, ok: true };
  if (hasComments(clean)) return { data: null, raw, ok: false, reason: 'has comments (JSONC); House Rules will not rewrite it' };
  try { const data = JSON.parse(clean); if (!data || typeof data !== 'object' || Array.isArray(data)) return { data: null, raw, ok: false, reason: 'top level is not an object' }; return { data, raw, ok: true }; }
  catch (e) { return { data: null, raw, ok: false, reason: `invalid JSON (${e.message})` }; }
}

function detectIndent(raw) { const m = raw && raw.match(/\n([ \t]+)"/); return m ? m[1] : 2; }

function stringify(data, raw) {
  const eol = raw && raw.includes('\r\n') ? '\r\n' : '\n';
  return JSON.stringify(data, null, detectIndent(raw)).replace(/\n/g, eol) + eol;
}

const clone = o => JSON.parse(JSON.stringify(o));
const isOurs = s => typeof s === 'string' && s.includes('houserules.cjs');

// hooks[event] = [{ matcher?, hooks: [{ type, command, ... }] }]  (Claude Code, Codex, Grok, Gemini, VS Code shape)
function setNestedHook(settings, event, entry) {
  const s = clone(settings || {});
  s.hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  const list = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
  const kept = list.map(g => ({ ...g, hooks: Array.isArray(g.hooks) ? g.hooks.filter(h => !isOurs(h && h.command)) : g.hooks }))
    .filter(g => !Array.isArray(g.hooks) || g.hooks.length);
  if (entry) kept.push(entry);
  if (kept.length) s.hooks[event] = kept; else delete s.hooks[event];
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

// hooks[event] = [{ command }]  (Cursor shape) or [{ type, bash, powershell }] (Copilot shape)
function setFlatHook(settings, event, entry, extra = {}) {
  const s = clone(settings || {});
  Object.assign(s, { ...extra, ...s });
  s.hooks = s.hooks && typeof s.hooks === 'object' ? s.hooks : {};
  const list = Array.isArray(s.hooks[event]) ? s.hooks[event] : [];
  const kept = list.filter(h => !(isOurs(h && h.command) || isOurs(h && h.bash) || isOurs(h && h.powershell)));
  if (entry) kept.push(entry);
  if (kept.length) s.hooks[event] = kept; else delete s.hooks[event];
  if (!Object.keys(s.hooks).length) delete s.hooks;
  return s;
}

// Adds (or removes) exactly the listed strings in an array at a dotted path, leaving everything else alone.
function setListEntries(settings, dotted, add, remove = []) {
  const s = clone(settings || {});
  const keys = dotted.split('.');
  let o = s;
  for (const k of keys.slice(0, -1)) { if (!o[k] || typeof o[k] !== 'object') o[k] = {}; o = o[k]; }
  const last = keys[keys.length - 1];
  const cur = Array.isArray(o[last]) ? o[last].filter(x => !remove.includes(x)) : [];
  for (const a of add) if (!cur.includes(a)) cur.push(a);
  if (cur.length) o[last] = cur; else delete o[last];
  return s;
}

module.exports = { readJsonFile, stringify, setNestedHook, setFlatHook, setListEntries, hasComments, isOurs, clone };
