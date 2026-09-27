'use strict';
// Turns .houserules/ (rules, policy, skills) into the files each assistant reads, and can undo exactly what it wrote.
// Every change is either a marked block inside a shared file, a tracked entry inside a shared JSON file, or a whole
// file House Rules owns. Tool formats: see docs/TOOLS.md (vendor docs checked 2026-09-26).
const fs = require('fs');
const path = require('path');
const { upsertBlock, removeBlock, readIf, writeIfChanged } = require('./blocks.cjs');
const J = require('./jsonfile.cjs');
const { loadPolicy } = require('./policy.cjs');
const { VERSION } = require('./version.cjs');

const TOOLS = ['claude', 'codex', 'copilot', 'cursor', 'gemini', 'grok', 'vscode'];
const RUNTIME_FILES = ['adapters.cjs', 'blocks.cjs', 'cli.cjs', 'generate.cjs', 'githook.cjs', 'guard.cjs', 'jsonfile.cjs', 'policy.cjs', 'secrets.cjs', 'templates.cjs', 'version.cjs', 'detect.cjs'];
const MAX_AGENTS_BLOCK = 9000;   // Grok documents a 10,000-character cap per instruction file in one of its two docs; Codex stops at 32 KiB.

// One hook command for every tool. It finds .houserules/runtime from the folder the tool runs it in, so it works from
// sub-folders, in bash, PowerShell, and cmd alike, and needs no environment variable. No "$" or backticks inside, so no
// shell expands anything. If the runtime is missing it says so on stderr and lets the command through (fail-open).
function hookCommand(tool) {
  const js = "const p=require('path'),f=require('fs');let d=process.cwd();for(;;){const x=p.join(d,'.houserules','runtime','houserules.cjs');if(f.existsSync(x)){process.argv.splice(1,0,x);require(x);break}const u=p.dirname(d);if(u===d){console.error('House Rules: runtime not found, command not checked');break}d=u}";
  return `node -e "${js}" guard --from ${tool}`;
}

function selectedTools(policy) {
  if (!Array.isArray(policy.tools)) return TOOLS.slice();
  return TOOLS.filter(t => policy.tools.includes(t));
}

// ---------- skills ----------
function parseFrontmatter(text) {
  const m = String(text).replace(/^﻿/, '').match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!m) return null;
  const out = {};
  for (const line of m[1].split(/\r?\n/)) {
    const kv = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (kv) out[kv[1]] = kv[2].replace(/^["']|["']$/g, '').trim();
  }
  return out;
}

// agentskills.io: name 1-64 chars, a-z 0-9 and hyphens, no leading/trailing/double hyphen, equal to the folder name;
// description 1-1024 chars. Codex requires both fields, so every skill must have them.
function readSkills(root) {
  const dir = path.join(root, '.houserules', 'skills');
  const skills = [], errors = [];
  if (!fs.existsSync(dir)) return { skills, errors };
  for (const name of fs.readdirSync(dir).sort()) {
    const sdir = path.join(dir, name);
    if (!fs.statSync(sdir).isDirectory()) continue;
    const md = readIf(path.join(sdir, 'SKILL.md'));
    if (md == null) { errors.push(`skills/${name}: missing SKILL.md`); continue; }
    const fm = parseFrontmatter(md);
    if (!fm) { errors.push(`skills/${name}/SKILL.md: needs a --- frontmatter block with name and description`); continue; }
    if (!/^[a-z0-9](?:[a-z0-9]|-(?!-)){0,62}[a-z0-9]$|^[a-z0-9]$/.test(name)) errors.push(`skills/${name}: folder name must be 1-64 lowercase letters, digits, single hyphens`);
    if (fm.name !== name) errors.push(`skills/${name}/SKILL.md: "name" must be "${name}" (the folder name)`);
    if (!fm.description || fm.description.length > 1024) errors.push(`skills/${name}/SKILL.md: "description" is required, up to 1024 characters`);
    skills.push({ name, dir: sdir, description: fm.description || '' });
  }
  return { skills, errors };
}

function listFiles(dir, base = dir) {
  const out = [];
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f);
    if (fs.statSync(p).isDirectory()) out.push(...listFiles(p, base)); else out.push(path.relative(base, p));
  }
  return out.sort();
}

const SKILL_MARK = '.houserules-managed';
const SKILL_DIRS = [path.join('.claude', 'skills'), path.join('.agents', 'skills')];

// ---------- content ----------
// rules.md as the assistants should see it: no notes-to-self comments, no top title, headings one level below
// "## House Rules" so the block nests cleanly inside any existing AGENTS.md.
function rulesForAgents(root) {
  const raw = (readIf(path.join(root, '.houserules', 'rules.md')) || '').replace(/^﻿/, '').replace(/\r\n/g, '\n');
  return raw.replace(/<!--[\s\S]*?-->/g, '').replace(/^#\s+.*\n?/m, '').replace(/^(#{2,5})\s/gm, (m, h) => `${h}# `).replace(/\n{3,}/g, '\n\n').trim();
}

function agentsBlock(root, policy, skills) {
  const rules = rulesForAgents(root);
  const deny = policy.rules.filter(r => r.action === 'deny');
  const ask = policy.rules.filter(r => r.action === 'ask');
  const lines = [
    '## House Rules',
    'These rules apply to every AI assistant in this repository. They come from `.houserules/`; change them there, then run `node .houserules/runtime/houserules.cjs sync`.',
    '',
    rules,
    '',
    '### Guardrails (checked by a hook before any shell command runs)',
    `- Blocked: ${deny.map(r => r.why.replace(/\.$/, '').toLowerCase()).join('; ')}.`,
    `- Needs a person's approval first: ${ask.map(r => r.why.replace(/\.$/, '').toLowerCase()).join('; ')}.`,
    `- Never read, print, copy, or edit these files: ${policy.protectedPaths.filter(p => !p.startsWith('**/')).concat(policy.protectedPaths.filter(p => p.startsWith('**/')).map(p => p.slice(3))).filter((v, i, a) => a.indexOf(v) === i).join(', ')}.`,
    '- If House Rules blocks a command, do not try another way to do the same thing (a different command, a script file, encoding, or another tool). Stop and tell the user what you wanted to do and why.',
    '- Every commit is scanned for secrets. Do not bypass git hooks.',
  ];
  if (skills.length) {
    lines.push('', '### Shared skills', 'In `.agents/skills/` and `.claude/skills/`:');
    for (const s of skills) lines.push(`- \`${s.name}\`: ${s.description}`);
  }
  return lines.join('\n');
}

function chatgptExport(root, policy) {
  const rules = rulesForAgents(root).replace(/^#+\s+/gm, '');
  const deny = policy.rules.filter(r => r.action === 'deny').map(r => r.why.replace(/\.$/, '').toLowerCase());
  const ask = policy.rules.filter(r => r.action === 'ask').map(r => r.why.replace(/\.$/, '').toLowerCase());
  let text = `How to work with me on code and business tasks.\n\n${rules}\n\nNever suggest commands that: ${deny.join('; ')}.\nWarn me and wait for my OK before anything that: ${ask.join('; ')}.\nNever ask me to paste API keys, passwords, or .env files.`;
  text = text.replace(/\n{3,}/g, '\n\n');
  return text;
}

// ---------- the plan ----------
// Each op: { file, kind: 'block'|'json'|'owned', ... }. Ops are pure given (disk, state), so the same code writes,
// checks for drift, and undoes.
function buildPlan(root) {
  const { policy, errors: policyErrors } = loadPolicy(root);
  const { skills, errors: skillErrors } = readSkills(root);
  const tools = selectedTools(policy);
  const has = t => tools.includes(t);
  const ops = [];
  const warnings = [];
  const agents = agentsBlock(root, policy, skills);
  if (agents.length > MAX_AGENTS_BLOCK) warnings.push(`AGENTS.md block is ${agents.length} characters; Grok may cap instruction files at 10,000 and Codex stops at 32 KiB in total. Shorten .houserules/rules.md.`);

  ops.push({ file: 'AGENTS.md', kind: 'block', style: 'md', position: 'bottom', body: agents });

  if (has('claude')) {
    ops.push({ file: 'CLAUDE.md', kind: 'block', style: 'md', position: 'top', body: '@AGENTS.md' });
    const deny = [];
    for (const p of policy.protectedPaths) {
      const rel = p.startsWith('**/') || p.startsWith('/') || p.startsWith('./') ? p : `./${p}`;
      deny.push(`Read(${rel})`, `Edit(${rel})`);
    }
    ops.push({ file: '.claude/settings.json', kind: 'json', apply: (d, st, undo) => {
      let s = J.setNestedHook(d, 'PreToolUse', undo ? null : { matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: hookCommand('claude'), timeout: 15 }] });
      const prev = st.claudeDenyAdded || [];
      if (undo) { st.claudeDenyAdded = []; return J.setListEntries(s, 'permissions.deny', [], prev); }
      const base = J.setListEntries(s, 'permissions.deny', [], prev);
      const existing = new Set((base.permissions && base.permissions.deny) || []);
      st.claudeDenyAdded = deny.filter(x => !existing.has(x));
      s = J.setListEntries(base, 'permissions.deny', st.claudeDenyAdded);
      if (s.permissions && !Object.keys(s.permissions).length) delete s.permissions;
      return s;
    } });
  }
  if (has('codex')) {
    ops.push({ file: '.codex/hooks.json', kind: 'json', apply: (d, st, undo) => J.setNestedHook(d, 'PreToolUse', undo ? null : { matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('codex'), timeout: 15 }] }) });
    const toml = readIf(path.join(root, '.codex', 'config.toml')) || '';
    const outside = removeBlock(toml, 'hash');
    if (/^\s*(approval_policy|sandbox_mode)\s*=/m.test(outside)) warnings.push('.codex/config.toml already sets approval_policy or sandbox_mode; House Rules left them as they are.');
    else ops.push({ file: '.codex/config.toml', kind: 'block', style: 'hash', position: 'top', body: '# Ask before commands that leave the sandbox; edits stay inside this project.\napproval_policy = "on-request"\nsandbox_mode = "workspace-write"' });
  }
  if (has('copilot')) {
    const cmd = hookCommand('copilot');
    ops.push({ file: '.github/hooks/houserules.json', kind: 'owned', content: J.stringify({ version: 1, hooks: { preToolUse: [{ type: 'command', bash: cmd, powershell: cmd, timeoutSec: 15 }] } }) });
  }
  if (has('cursor')) {
    ops.push({ file: '.cursor/hooks.json', kind: 'json', apply: (d, st, undo) => {
      const s = J.setFlatHook(d, 'beforeShellExecution', undo ? null : { command: hookCommand('cursor') }, undo ? {} : { version: 1 });
      if (undo && s.hooks === undefined && Object.keys(s).length === 1 && s.version === 1) delete s.version;
      return s;
    } });
  }
  if (has('gemini')) {
    ops.push({ file: '.gemini/settings.json', kind: 'json', apply: (d, st, undo) => {
      let s = J.setNestedHook(d, 'BeforeTool', undo ? null : { matcher: 'run_shell_command', hooks: [{ name: 'houserules-guard', type: 'command', command: hookCommand('gemini'), timeout: 15000 }] });
      s.context = s.context && typeof s.context === 'object' ? s.context : {};
      if (!st.geminiPrior) st.geminiPrior = { value: s.context.fileName === undefined ? null : s.context.fileName };
      if (undo) {
        if (st.geminiPrior.value === null) delete s.context.fileName; else s.context.fileName = st.geminiPrior.value;
        delete st.geminiPrior;
      } else {
        const prior = st.geminiPrior.value;
        const list = prior === null ? ['GEMINI.md'] : Array.isArray(prior) ? prior.slice() : [prior];
        if (!list.includes('AGENTS.md')) list.unshift('AGENTS.md');
        s.context.fileName = list;
      }
      if (!Object.keys(s.context).length) delete s.context;
      return s;
    } });
  }
  if (has('grok')) {
    ops.push({ file: '.grok/hooks/houserules.json', kind: 'owned', content: J.stringify({ hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: hookCommand('grok'), timeout: 15 }] }] } }) });
  }
  if (has('vscode')) {
    const recs = [has('claude') && 'anthropic.claude-code', has('codex') && 'openai.chatgpt', has('copilot') && 'GitHub.copilot-chat'].filter(Boolean);
    ops.push({ file: '.vscode/extensions.json', kind: 'json', apply: (d, st, undo) => {
      const prev = st.vscodeExtAdded || [];
      const base = J.setListEntries(d, 'recommendations', [], prev);
      if (undo) { st.vscodeExtAdded = []; return base; }
      const existing = new Set(base.recommendations || []);
      st.vscodeExtAdded = recs.filter(x => !existing.has(x));
      return J.setListEntries(base, 'recommendations', st.vscodeExtAdded);
    } });
    ops.push({ file: '.vscode/settings.json', kind: 'json', apply: (d, st, undo) => {
      const s = J.clone(d || {});
      if (!st.vscodePrior) st.vscodePrior = { value: s['chat.useAgentsMdFile'] === undefined ? null : s['chat.useAgentsMdFile'] };
      if (undo) { if (st.vscodePrior.value === null) delete s['chat.useAgentsMdFile']; else s['chat.useAgentsMdFile'] = st.vscodePrior.value; delete st.vscodePrior; }
      else s['chat.useAgentsMdFile'] = true;
      return s;
    } });
    const run = 'node .houserules/runtime/houserules.cjs';
    const tasks = [
      { label: 'House Rules: sync', type: 'shell', command: `${run} sync`, problemMatcher: [] },
      { label: 'House Rules: doctor', type: 'shell', command: `${run} doctor`, problemMatcher: [] },
      { label: 'House Rules: scan for secrets', type: 'shell', command: `${run} scan`, problemMatcher: [] },
    ];
    ops.push({ file: '.vscode/tasks.json', kind: 'json', apply: (d, st, undo) => {
      const s = J.clone(d || {});
      const kept = (Array.isArray(s.tasks) ? s.tasks : []).filter(t => !(t && typeof t.label === 'string' && t.label.startsWith('House Rules:')));
      if (undo) { if (kept.length) s.tasks = kept; else { delete s.tasks; if (s.version === '2.0.0' && Object.keys(s).length === 1) delete s.version; } return s; }
      s.version = s.version || '2.0.0';
      s.tasks = [...kept, ...tasks];
      return s;
    } });
  }
  ops.push({ file: '.houserules/out/chatgpt-instructions.md', kind: 'owned', content: chatgptExport(root, policy) + '\n' });

  return { ops, skills, tools, policy, errors: [...policyErrors, ...skillErrors], warnings };
}

// ---------- state ----------
const STATE = path.join('.houserules', 'state.json');
function readState(root) { const r = J.readJsonFile(path.join(root, STATE)); return r.ok && r.data ? r.data : {}; }
function writeState(root, st) { writeIfChanged(path.join(root, STATE), J.stringify({ ...st, version: VERSION })); }

// ---------- apply / check / undo ----------
function runOps(root, plan, { dryRun = false, undo = false } = {}) {
  const st = readState(root);
  st.created = Array.isArray(st.created) ? st.created : [];
  const changed = [], skipped = [];
  for (const op of plan.ops) {
    const abs = path.join(root, op.file);
    const existed = fs.existsSync(abs);
    let next = null;
    if (op.kind === 'block') {
      const cur = readIf(abs) || '';
      next = undo ? removeBlock(cur, op.style) : upsertBlock(cur, op.body, op.style, op.position);
      const norm = s => s.replace(/\r\n/g, '\n');
      if (norm(next) === norm(cur)) continue;
      if (undo && !next.trim() && st.created.includes(op.file)) { changed.push(op.file); if (!dryRun) { fs.unlinkSync(abs); st.created = st.created.filter(f => f !== op.file); } continue; }
    } else if (op.kind === 'json') {
      const r = J.readJsonFile(abs);
      if (!r.ok) { skipped.push(`${op.file}: ${r.reason}`); continue; }
      const data = op.apply(r.data, st, undo);
      if (JSON.stringify(data) === JSON.stringify(r.data) && existed) continue;
      if (!existed && undo) continue;
      if (undo && !Object.keys(data).length && st.created.includes(op.file)) { changed.push(op.file); if (!dryRun) { fs.unlinkSync(abs); st.created = st.created.filter(f => f !== op.file); } continue; }
      if (!existed && !Object.keys(data).length) continue;
      next = J.stringify(data, r.raw);
    } else if (op.kind === 'owned') {
      if (undo) { if (existed) { changed.push(op.file); if (!dryRun) fs.unlinkSync(abs); } continue; }
      next = op.content;
      const cur = readIf(abs);
      if (cur != null && cur.replace(/\r\n/g, '\n') === next) continue;
    }
    changed.push(op.file);
    if (!dryRun) {
      writeIfChanged(abs, next);
      if (!existed && !st.created.includes(op.file) && op.kind !== 'owned') st.created.push(op.file);
    }
  }
  const skillChanges = syncSkills(root, plan.skills, { dryRun, undo });
  changed.push(...skillChanges.changed); skipped.push(...skillChanges.skipped);
  if (!dryRun) {
    if (undo) { delete st.claudeDenyAdded; delete st.vscodeExtAdded; }
    writeState(root, st);
  }
  return { changed, skipped };
}

function syncSkills(root, skills, { dryRun, undo }) {
  const changed = [], skipped = [];
  const want = undo ? [] : skills;
  for (const rel of SKILL_DIRS) {
    const base = path.join(root, rel);
    const managed = fs.existsSync(base) ? fs.readdirSync(base).filter(n => fs.existsSync(path.join(base, n, SKILL_MARK))) : [];
    for (const name of managed) {
      if (want.some(s => s.name === name)) continue;
      changed.push(`${rel}/${name}/ (removed)`.replace(/\\/g, '/'));
      if (!dryRun) fs.rmSync(path.join(base, name), { recursive: true, force: true });
    }
    for (const s of want) {
      const dest = path.join(base, s.name);
      if (fs.existsSync(dest) && !fs.existsSync(path.join(dest, SKILL_MARK))) { skipped.push(`${rel}/${s.name}: a skill with this name already exists and was not made by House Rules`.replace(/\\/g, '/')); continue; }
      const files = listFiles(s.dir);
      const same = fs.existsSync(dest) && JSON.stringify(listFiles(dest).filter(f => f !== SKILL_MARK)) === JSON.stringify(files) &&
        files.every(f => fs.readFileSync(path.join(dest, f)).equals(fs.readFileSync(path.join(s.dir, f))));
      if (same) continue;
      changed.push(`${rel}/${s.name}/`.replace(/\\/g, '/'));
      if (dryRun) continue;
      fs.rmSync(dest, { recursive: true, force: true });
      for (const f of files) { const to = path.join(dest, f); fs.mkdirSync(path.dirname(to), { recursive: true }); fs.copyFileSync(path.join(s.dir, f), to); }
      fs.writeFileSync(path.join(dest, SKILL_MARK), 'Copied from .houserules/skills by House Rules. Edit the original there, then run sync.\n');
    }
  }
  return { changed, skipped };
}

// Copies the runtime (this program) into .houserules/runtime so hooks and teammates need nothing installed.
function installRuntime(root, fromDir = __dirname, { dryRun = false } = {}) {
  const dest = path.join(root, '.houserules', 'runtime');
  const changed = [];
  const entry = "'use strict';\n// House Rules runtime entry. Generated; do not edit. Update with: npx github:LogicTalkAI/houserules sync\nrequire('./cli.cjs').main(process.argv.slice(2));\n";
  const want = [...RUNTIME_FILES.map(f => [f, fs.readFileSync(path.join(fromDir, f), 'utf8')]), ['houserules.cjs', entry]];
  for (const [f, content] of want) {
    const cur = readIf(path.join(dest, f));
    if (cur != null && cur.replace(/\r\n/g, '\n') === content.replace(/\r\n/g, '\n')) continue;
    changed.push(`.houserules/runtime/${f}`);
    if (!dryRun) writeIfChanged(path.join(dest, f), content);
  }
  return changed;
}


module.exports = { TOOLS, RUNTIME_FILES, buildPlan, runOps, installRuntime, hookCommand, readSkills, parseFrontmatter, readState, selectedTools, agentsBlock, chatgptExport, SKILL_DIRS, SKILL_MARK, MAX_AGENTS_BLOCK };
