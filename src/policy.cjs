'use strict';
// The default rulebook for shell commands an AI agent may run, plus loading and merging a project's own policy.
// Rules are data, so a team can read them, switch one off, or add its own in .houserules/policy.json.
const fs = require('fs');
const path = require('path');

// action: "deny" = never run; "ask" = a person must approve (tools without an approval prompt treat it as deny).
// match: one regular expression (string), tested against the whole command and against each chained part.
const DEFAULT_RULES = [
  // ---- destroys data or the machine ----
  { id: 'rm-rf-root', action: 'deny', why: 'Recursive delete of the root, home, or current folder.',
    match: String.raw`\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*(?:[rR][a-zA-Z]*f|f[a-zA-Z]*[rR])[a-zA-Z]*\s+(?:-[a-zA-Z-]+\s+)*(?:\/|\/\*|~|~\/|\*|\.|\.\/|\.\.|\$HOME|\$\{HOME\})(?=\s|$|[;&|])` },
  { id: 'ps-remove-root', action: 'deny', why: 'PowerShell recursive delete of a drive root, home, or everything in the folder.',
    match: String.raw`\b(?:Remove-Item|rm|ri|del|rd|rmdir)\b(?=[^;&|]*-Recurse)[^;&|]*\s(?:[A-Za-z]:\\?|\\|~|\$HOME|\$env:USERPROFILE|\*|\.)(?=\s|$|[;&|])` , flags: 'i' },
  { id: 'disk-wipe', action: 'deny', why: 'Formats or overwrites a disk.',
    match: String.raw`\bmkfs(?:\.\w+)?\b|\bdd\s+[^|;&]*\bof=\/dev\/(?:sd|hd|nvme|disk|mmcblk)|\bformat(?:\.com)?\s+[A-Za-z]:|\bdiskpart\b|\bClear-Disk\b`, flags: 'i' },
  { id: 'fork-bomb', action: 'deny', why: 'Fork bomb.', match: String.raw`:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:` },
  { id: 'chmod-777-recursive', action: 'deny', why: 'Makes every file world-writable.', match: String.raw`\bchmod\s+(?:-[a-zA-Z]*R[a-zA-Z]*\s+)777\b|\bchmod\s+777\s+-R\b` },
  // ---- runs code from the internet ----
  { id: 'pipe-to-shell', action: 'deny', why: 'Downloads a script and runs it without anyone reading it.',
    match: String.raw`\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&]*\|\s*(?:sudo\s+)?(?:ba|z|da|k|fi)?sh\b|\b(?:curl|wget|iwr|irm|Invoke-WebRequest|Invoke-RestMethod)\b[^;&]*\|\s*(?:iex|Invoke-Expression)\b|\b(?:ba|z)?sh\s+<\(\s*(?:curl|wget)\b`, flags: 'i' },
  // ---- leaks secrets ----
  { id: 'read-secret-file', action: 'deny', why: 'Prints a file that usually holds keys or passwords.',
    match: String.raw`\b(?:cat|type|more|less|head|tail|bat|nl|strings|Get-Content|gc|Select-String)\b[^;&|]*(?:^|[\s\/\\"'=])(?:\.env(?:\.[\w.-]+)?|\.dev\.vars|id_rsa|id_ed25519|[\w.-]+\.pem|[\w.-]+\.p12|[\w.-]+\.pfx|credentials\.json|secrets?\.(?:json|ya?ml|toml))(?=["'\s]|$)`, flags: 'i' },
  { id: 'print-all-env', action: 'deny', why: 'Prints every environment variable, which usually includes API keys.',
    match: String.raw`(?:^|[;&|]\s*)(?:printenv|env|set|export\s+-p)\s*(?=$|[|;&>])|\bGet-ChildItem\s+env:|\b(?:gci|dir|ls)\s+env:`, flags: 'i' },
  { id: 'echo-secret-var', action: 'deny', why: 'Prints a variable that looks like a key, token, or password.',
    match: String.raw`\b(?:echo|printf|Write-Host|Write-Output)\b[^;&|]*\$(?:\{|env:)?\w*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|PRIVATE)\w*`, flags: 'i' },
  // ---- bypasses the safety net ----
  { id: 'git-no-verify', action: 'deny', why: 'Skips the git hooks, including the House Rules secret scan.',
    match: String.raw`\bgit\s+(?:commit|push|merge|rebase|am|cherry-pick|revert)\b[^;&|]*\s--no-verify(?=\s|$)|\bgit\s+commit\b[^;&|]*\s-[a-zA-Z]*n[a-zA-Z]*(?=\s|$)` },
  { id: 'git-force-push-main', action: 'deny', why: 'Force-pushes over the main branch, erasing other people\'s work.',
    match: String.raw`\bgit\s+push\b(?=[^;&|]*\s(?:--force(?:-with-lease)?|-f)(?=\s|$))[^;&|]*\s\+?(?:main|master|production|prod)(?=\s|$)` },
  // ---- needs a person ----
  { id: 'git-force-push', action: 'ask', why: 'Force push rewrites shared history.', match: String.raw`\bgit\s+push\b[^;&|]*\s(?:--force(?:-with-lease)?|-f)(?=\s|$)` },
  { id: 'git-push', action: 'ask', why: 'Push sends code to a shared remote, which may deploy it.', match: String.raw`\bgit\s+push\b` },
  { id: 'git-destructive', action: 'ask', why: 'Throws away local work or history.',
    match: String.raw`\bgit\s+(?:reset\s+--hard|clean\s+-[a-zA-Z]*f[a-zA-Z]*|checkout\s+--\s|restore\s+--source|branch\s+-D|stash\s+(?:drop|clear)|filter-branch|filter-repo|update-ref\s+-d)\b` },
  { id: 'recursive-delete', action: 'ask', why: 'Recursive delete.', match: String.raw`\brm\s+(?:-[a-zA-Z]+\s+)*-[a-zA-Z]*[rR]|\b(?:Remove-Item|ri|rd|rmdir)\b[^;&|]*-Recurse|\brmdir\s+\/s\b|\bshutil\.rmtree\b`, flags: 'i' },
  { id: 'publish-deploy', action: 'ask', why: 'Publishes or deploys to production.',
    match: String.raw`\b(?:npm|pnpm|yarn|bun)\s+(?:npm\s+)?publish\b|\bnpx\s+wrangler\s+deploy\b|\bwrangler\s+(?:deploy|publish|secret\s+put|d1\s+execute\b[^;&|]*--remote)\b|\bvercel\b[^;&|]*--prod\b|\bnetlify\s+deploy\b[^;&|]*--prod\b|\bfirebase\s+deploy\b|\bfly(?:ctl)?\s+deploy\b|\bterraform\s+(?:apply|destroy)\b|\bpulumi\s+(?:up|destroy)\b|\bkubectl\s+(?:apply|delete|replace|scale|drain)\b|\bhelm\s+(?:install|upgrade|uninstall)\b|\bdocker\s+push\b|\bgh\s+(?:release\s+create|repo\s+(?:delete|create)|pr\s+merge)\b|\bheroku\s+\w+:(?:destroy|reset)\b|\bcdk\s+(?:deploy|destroy)\b|\bsam\s+deploy\b|\beas\s+submit\b|\btwine\s+upload\b|\bcargo\s+publish\b|\bgem\s+push\b`, flags: 'i' },
  { id: 'cloud-delete', action: 'ask', why: 'Deletes cloud resources or storage.',
    match: String.raw`\baws\s+s3\s+(?:rm|rb)\b|\baws\s+\S+\s+delete-|\bgcloud\s+[^;&|]*\bdelete\b|\baz\s+[^;&|]*\bdelete\b|\bgsutil\s+(?:rm|rb)\b`, flags: 'i' },
  { id: 'sql-drop', action: 'ask', why: 'Drops or empties a database table.', match: String.raw`\b(?:drop\s+(?:database|schema|table)|truncate\s+(?:table\s+)?\w)`, flags: 'i' },
  { id: 'sudo', action: 'ask', why: 'Runs as administrator.', match: String.raw`(?:^|[;&|]\s*)sudo\s|\bStart-Process\b[^;&|]*-Verb\s+RunAs\b`, flags: 'i' },
];

// Files an agent should never read or edit through its file tools (enforced by tools that support path rules).
const DEFAULT_PROTECTED_PATHS = ['.env', '.env.*', '**/.env', '**/.env.*', '**/.dev.vars', '**/*.pem', '**/*.key', '**/*.p12', '**/*.pfx', '**/id_rsa*', '**/id_ed25519*', '**/credentials.json', '**/secrets.json', '**/secrets.yml', '**/secrets.yaml'];

const DEFAULT_POLICY = {
  version: 1,
  // Which assistants get generated files. "auto" = every supported tool. Or list: ["claude", "codex", "copilot", ...].
  tools: 'auto',
  disable: [],
  rules: [],
  protectedPaths: [],
  secrets: { scanOnCommit: true, allow: [], ignorePaths: [] },
};

function readJson(file) {
  const raw = fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  return JSON.parse(raw);
}

function validateRule(r, where) {
  const errs = [];
  if (!r || typeof r !== 'object') return [`${where}: a rule must be an object`];
  if (!r.id || !/^[a-z0-9][a-z0-9-]{1,60}$/.test(r.id)) errs.push(`${where}: "id" must be lowercase letters, digits, dashes`);
  if (!['deny', 'ask', 'allow'].includes(r.action)) errs.push(`${where} (${r.id}): "action" must be deny, ask, or allow`);
  if (typeof r.match !== 'string' || !r.match) errs.push(`${where} (${r.id}): "match" must be a regular expression string`);
  else { try { new RegExp(r.match, r.flags || ''); } catch (e) { errs.push(`${where} (${r.id}): bad regular expression: ${e.message}`); } }
  return errs;
}

// Project policy = defaults, minus disabled rule ids, plus project rules (project rules are checked first, so an
// "allow" rule can make an exception to a default).
function loadPolicy(root) {
  const file = path.join(root, '.houserules', 'policy.json');
  let project = {};
  const errors = [];
  if (fs.existsSync(file)) {
    try { project = readJson(file); } catch (e) { errors.push(`.houserules/policy.json is not valid JSON: ${e.message}`); }
  }
  const p = { ...DEFAULT_POLICY, ...project, secrets: { ...DEFAULT_POLICY.secrets, ...(project.secrets || {}) } };
  const disabled = new Set(Array.isArray(p.disable) ? p.disable : []);
  const own = Array.isArray(p.rules) ? p.rules : [];
  own.forEach((r, i) => errors.push(...validateRule(r, `policy.json rules[${i}]`)));
  const rules = [...own.map(r => ({ ...r, source: 'project' })), ...DEFAULT_RULES.filter(r => !disabled.has(r.id)).map(r => ({ ...r, source: 'default' }))];
  const protectedPaths = [...new Set([...DEFAULT_PROTECTED_PATHS, ...(Array.isArray(p.protectedPaths) ? p.protectedPaths : [])])];
  return { policy: { ...p, rules, protectedPaths }, errors, file };
}

module.exports = { DEFAULT_RULES, DEFAULT_PROTECTED_PATHS, DEFAULT_POLICY, loadPolicy, validateRule, readJson };
