'use strict';
// House Rules command line. Zero dependencies; Node 18+.
const fs = require('fs');
const path = require('path');
const { spawnSync, execFileSync } = require('child_process');
const { VERSION } = require('./version.cjs');
const { loadPolicy } = require('./policy.cjs');
const { evaluate } = require('./guard.cjs');
const A = require('./adapters.cjs');
const S = require('./secrets.cjs');
const G = require('./generate.cjs');
const hook = require('./githook.cjs');
const { detect } = require('./detect.cjs');
const T = require('./templates.cjs');
const { writeIfChanged, readIf } = require('./blocks.cjs');
const { stringify } = require('./jsonfile.cjs');

const HELP = `House Rules ${VERSION}: one rulebook for every AI coding assistant.

Usage: houserules <command> [options]

  init        Set up House Rules in this project (safe to run again).
                --tools claude,codex,...   only these assistants (default: all supported)
                --no-git-hook              skip the pre-commit secret scan
                --no-sample-skill          do not add the starter "safe-change" skill
  sync        Rewrite every assistant's files from .houserules/ after you edit it.
  doctor      Check setup, prove each assistant's hook blocks a dangerous command, list next steps.
  check       For CI: fail if files are out of sync, the policy is invalid, or a tracked file holds a secret.
  rules       List the command rules in force.
  test "<command>"   Show what House Rules would decide for a command.
  scan [--staged] [paths]   Look for secrets (staged changes, given paths, or every tracked file).
  audit       Show the most recent blocked or held commands.
  export chatgpt     Print the rules condensed for ChatGPT Custom Instructions or a Project.
  uninstall   Remove everything House Rules added (keeps .houserules/ unless --all).
  version     Print the version.

Assistants: claude (Claude Code), codex (OpenAI Codex), copilot (GitHub Copilot), cursor, gemini (Gemini CLI),
grok (Grok Build), vscode (VS Code settings, tasks, extension suggestions). ChatGPT: see "export chatgpt".
Docs: https://github.com/LogicTalkAI/houserules`;

const out = (...a) => process.stdout.write(a.join(' ') + '\n');
const err = (...a) => process.stderr.write(a.join(' ') + '\n');

function flag(argv, name) { return argv.includes(name); }
function opt(argv, name) { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; }

// The project root: the folder holding .houserules/ (walking up), else the git root, else the current folder.
function findRoot(start = process.cwd()) {
  let d = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(d, '.houserules'))) return d;
    const up = path.dirname(d);
    if (up === d) break;
    d = up;
  }
  try { return execFileSync('git', ['rev-parse', '--show-toplevel'], { cwd: start, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return path.resolve(start); }
}

function readStdin() { try { return fs.readFileSync(0, 'utf8'); } catch { return ''; } }

function redactCommand(cmd) {
  let c = String(cmd).slice(0, 300);
  for (const p of S.PATTERNS) c = c.replace(new RegExp(p.re.source, 'g'), m => S.redact(m));
  return c.replace(/[\r\n]+/g, ' ');
}

function audit(root, tool, verdict, command) {
  if (verdict.decision === 'allow') return;
  try {
    const file = path.join(root, '.houserules', 'audit.log');
    const line = `${new Date().toISOString()}\t${tool}\t${verdict.decision}\t${verdict.rule}\t${redactCommand(command)}\n`;
    fs.appendFileSync(file, line);
    const st = fs.statSync(file);
    if (st.size > 512 * 1024) { const keep = fs.readFileSync(file, 'utf8').split('\n').slice(-2000).join('\n'); fs.writeFileSync(file, keep); }
  } catch { /* logging must never break the guard */ }
}

// ---------- guard: called by every assistant's hook ----------
function cmdGuard(argv) {
  const tool = opt(argv, '--from') || 'claude';
  try {
    const root = findRoot();
    const input = A.parse(readStdin());
    const command = A.commandFrom(tool, input);
    if (command == null) return 0;                         // not a shell command: nothing to check
    const { policy } = loadPolicy(root);
    const verdict = evaluate(command, policy);
    audit(root, tool, verdict, command);
    const ans = A.answer(tool, verdict);
    if (ans.stdout) process.stdout.write(ans.stdout + '\n');
    if (ans.stderr) process.stderr.write(ans.stderr + '\n');
    return ans.code;
  } catch (e) {
    err(`House Rules: guard error, command not checked: ${e && e.message}`);
    return 0;
  }
}

function cmdTest(argv) {
  const command = argv.filter(a => !a.startsWith('--')).join(' ');
  if (!command) { err('Usage: houserules test "<command>"'); return 1; }
  const { policy } = loadPolicy(findRoot());
  const v = evaluate(command, policy);
  out(`${v.decision.toUpperCase()}${v.rule ? `  (${v.rule})` : ''}  ${v.why}`);
  return 0;
}

function cmdRules() {
  const { policy, errors } = loadPolicy(findRoot());
  errors.forEach(e => err('policy: ' + e));
  for (const a of ['deny', 'ask', 'allow']) {
    const list = policy.rules.filter(r => r.action === a);
    if (!list.length) continue;
    out(`\n${a === 'deny' ? 'Blocked' : a === 'ask' ? 'Needs a person' : 'Allowed exceptions'}:`);
    for (const r of list) out(`  ${r.id.padEnd(22)} ${r.why || ''}${r.source === 'project' ? '  [project]' : ''}`);
  }
  out(`\nProtected files: ${policy.protectedPaths.join(', ')}`);
  return errors.length ? 1 : 0;
}

// ---------- scan ----------
function trackedFiles(root) {
  try { return execFileSync('git', ['ls-files', '-z'], { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).split('\0').filter(Boolean); }
  catch { return null; }
}

function printHits(hits) {
  for (const h of hits) out(`  ${h.file}${h.line ? `:${h.line}` : ''}  ${h.id}  ${h.preview}`);
}

function cmdScan(argv) {
  const root = findRoot();
  const { policy } = loadPolicy(root);
  const allow = (policy.secrets && policy.secrets.allow) || [];
  const ignore = (policy.secrets && policy.secrets.ignorePaths) || [];
  let res;
  if (flag(argv, '--staged')) {
    if (policy.secrets && policy.secrets.scanOnCommit === false) return 0;
    res = S.scanStaged(root, allow, ignore);
  } else {
    const paths = argv.filter(a => !a.startsWith('--'));
    const targets = paths.length ? paths : (trackedFiles(root) || []);
    res = targets.length ? S.scanPaths(root, targets, allow, ignore) : S.scanPaths(root, ['.'], allow, ignore);
    for (const f of targets) if (S.forbiddenFile(f) && !S.ignored(f, ignore)) res.hits.push({ file: f, line: 0, id: 'forbidden-file', preview: 'this kind of file holds secrets; remove it from git and add it to .gitignore' });
  }
  if (res.error) { err(`House Rules: ${res.error}`); return 0; }
  if (!res.hits.length) { if (!flag(argv, '--staged')) out(`House Rules: no secrets found in ${res.files} file(s).`); return 0; }
  err(`House Rules: possible secret${res.hits.length > 1 ? 's' : ''} found. The commit was stopped.`);
  printHits(res.hits);
  err('Move the value to an environment variable or your secret manager. If it is a false alarm, add "houserules:allow-secret" in a comment on that line.');
  return 1;
}

function cmdAudit(argv) {
  const root = findRoot();
  const log = readIf(path.join(root, '.houserules', 'audit.log'));
  if (!log) { out('No commands have been blocked or held yet.'); return 0; }
  const n = Number(opt(argv, '--last')) || 20;
  out('When (UTC)            Assistant  Decision  Rule                   Command');
  for (const line of log.trim().split('\n').slice(-n)) {
    const [t, tool, d, rule, c] = line.split('\t');
    out(`${t.slice(0, 19).replace('T', ' ')}  ${String(tool).padEnd(9)}  ${String(d).padEnd(8)}  ${String(rule).padEnd(21)}  ${c}`);
  }
  return 0;
}

// ---------- init / sync / uninstall ----------
function ensureGitignore(root) {
  const file = path.join(root, '.gitignore');
  const cur = readIf(file) || '';
  if (/^\/?\.houserules\/audit\.log$/m.test(cur)) return false;
  writeIfChanged(file, (cur && !cur.endsWith('\n') ? cur + '\n' : cur) + '# House Rules: local log of blocked commands\n.houserules/audit.log\n');
  return true;
}

function report(changed, skipped, warnings) {
  if (changed.length) { out(`Updated ${changed.length} file(s):`); changed.forEach(f => out(`  ${f}`)); }
  else out('Everything was already up to date.');
  (skipped || []).forEach(s => err(`  skipped ${s}`));
  (warnings || []).forEach(w => err(`  note: ${w}`));
}

function doSync(root, { quiet = false } = {}) {
  const runtime = G.installRuntime(root);
  const plan = G.buildPlan(root);
  if (plan.errors.length) { plan.errors.forEach(e => err('error: ' + e)); err('Fix the errors above in .houserules/, then run sync again. Nothing was changed.'); return { code: 1 }; }
  const { changed, skipped } = G.runOps(root, plan);
  if (!quiet) report([...runtime, ...changed], skipped, plan.warnings);
  return { code: 0, plan, changed: [...runtime, ...changed] };
}

function cmdInit(argv) {
  const root = path.resolve(opt(argv, '--dir') || findRoot());
  const hr = path.join(root, '.houserules');
  const created = [];
  const put = (rel, content) => { const f = path.join(hr, rel); if (!fs.existsSync(f)) { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, content); created.push(`.houserules/${rel}`.replace(/\\/g, '/')); } };
  const tools = opt(argv, '--tools');
  const policy = { ...T.POLICY_JSON };
  if (tools) {
    const list = tools.split(',').map(s => s.trim().toLowerCase()).filter(Boolean);
    const bad = list.filter(t => !G.TOOLS.includes(t));
    if (bad.length) { err(`Unknown assistant(s): ${bad.join(', ')}. Choose from: ${G.TOOLS.join(', ')}.`); return 1; }
    policy.tools = list;
  }
  put('rules.md', T.RULES_MD);
  put('policy.json', stringify(policy));
  put('README.md', T.README_MD);
  if (!flag(argv, '--no-sample-skill')) put('skills/safe-change/SKILL.md', T.SKILL_SAFE_CHANGE);
  else fs.mkdirSync(path.join(hr, 'skills'), { recursive: true });
  if (tools && !created.includes('.houserules/policy.json')) {
    const f = path.join(hr, 'policy.json');
    try { const cur = JSON.parse(fs.readFileSync(f, 'utf8')); cur.tools = policy.tools; fs.writeFileSync(f, stringify(cur)); } catch { err('Could not update "tools" in .houserules/policy.json; edit it by hand.'); }
  }
  out(`House Rules ${VERSION} in ${root}`);
  if (created.length) { out('Created:'); created.forEach(f => out(`  ${f}`)); }
  if (ensureGitignore(root)) out('  .gitignore (ignores .houserules/audit.log)');
  const r = doSync(root);
  if (r.code) return r.code;
  if (!flag(argv, '--no-git-hook')) {
    const h = hook.install(root);
    if (h.ok) out(h.changed ? `Installed the pre-commit secret scan (${path.relative(root, h.file).replace(/\\/g, '/')}).` : 'Pre-commit secret scan already installed.');
    else err(`Skipped the pre-commit secret scan: ${h.reason}. Run "git init", then "houserules init" again.`);
  }
  out('\nNext: run "node .houserules/runtime/houserules.cjs doctor" to prove every hook blocks, and see the one-time approvals each assistant asks for.');
  return 0;
}

function cmdSync() { return doSync(findRoot()).code; }

function cmdUninstall(argv) {
  const root = findRoot();
  if (!fs.existsSync(path.join(root, '.houserules'))) { out('House Rules is not set up here.'); return 0; }
  const plan = G.buildPlan(root);
  const { changed, skipped } = G.runOps(root, plan, { undo: true });
  const h = hook.uninstall(root);
  if (h.changed) changed.push('git pre-commit hook (House Rules part)');
  if (flag(argv, '--all')) { fs.rmSync(path.join(root, '.houserules'), { recursive: true, force: true }); changed.push('.houserules/ (deleted)'); }
  out('Removed House Rules from this project.');
  changed.forEach(f => out(`  ${f}`));
  skipped.forEach(s => err(`  skipped ${s}`));
  if (!flag(argv, '--all')) out('Your rules are still in .houserules/. Run "houserules init" to turn them back on, or "uninstall --all" to delete them.');
  return 0;
}

// ---------- doctor / check ----------
const SAMPLE_INPUT = {
  claude: c => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: c } }),
  codex: c => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: c } }),
  grok: c => ({ hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: c } }),
  gemini: c => ({ hook_event_name: 'BeforeTool', tool_name: 'run_shell_command', tool_input: { command: c } }),
  cursor: c => ({ hook_event_name: 'beforeShellExecution', command: c, cwd: process.cwd() }),
  copilot: c => ({ toolName: 'bash', toolArgs: JSON.stringify({ command: c }) }),
};

function selfTest(root, tool) {
  const make = SAMPLE_INPUT[tool];
  if (!make) return null;
  const r = spawnSync(G.hookCommand(tool), { shell: true, cwd: root, input: JSON.stringify(make('rm -rf /')), encoding: 'utf8', timeout: 20000 });
  const ok = r.status === 2;
  const safe = spawnSync(G.hookCommand(tool), { shell: true, cwd: root, input: JSON.stringify(make('git status')), encoding: 'utf8', timeout: 20000 });
  return { ok: ok && safe.status === 0, detail: ok ? (safe.status === 0 ? '' : `a safe command was not allowed (exit ${safe.status})`) : `expected exit 2, got ${r.status}${r.stderr ? ': ' + r.stderr.trim().slice(0, 160) : ''}` };
}

const NEXT_STEPS = {
  claude: 'Claude Code: open the project and accept the workspace trust prompt so project hooks run.',
  codex: 'Codex: trust this project (Codex asks on first run, or add [projects."<path>"] trust_level = "trusted" to ~/.codex/config.toml), then review and trust the House Rules hook when Codex shows it.',
  copilot: 'Copilot: hooks in .github/hooks run in Copilot CLI and the cloud agent; in VS Code keep "chat.useHooks" on.',
  cursor: 'Cursor: hooks load from .cursor/hooks.json; restart Cursor once after setup.',
  gemini: 'Gemini CLI: hooks are on by default; run /hooks in Gemini to confirm the House Rules hook is listed.',
  grok: 'Grok Build: run /hooks-trust once in this project so its hooks run.',
  vscode: 'VS Code: install the suggested extensions when prompted; tasks are under Terminal > Run Task > "House Rules".',
};

function cmdDoctor() {
  const root = findRoot();
  let problems = 0;
  const line = (ok, text) => { out(`${ok ? '  OK  ' : '  !!  '} ${text}`); if (!ok) problems++; };
  out(`House Rules ${VERSION}, project: ${root}\n`);
  if (!fs.existsSync(path.join(root, '.houserules'))) { out('House Rules is not set up here. Run: npx @logictalkai/houserules init'); return 1; }
  const plan = G.buildPlan(root);
  out('Setup');
  line(!plan.errors.length, plan.errors.length ? `policy or skills have errors:\n       ${plan.errors.join('\n       ')}` : `policy valid: ${plan.policy.rules.length} command rules, ${plan.policy.protectedPaths.length} protected file patterns, ${plan.skills.length} skill(s)`);
  const rt = G.installRuntime(root, __dirname, { dryRun: true });
  const runtimeHere = path.resolve(__dirname) === path.resolve(root, '.houserules', 'runtime');
  line(!rt.length || runtimeHere, rt.length && !runtimeHere ? `runtime is out of date (${rt.length} file(s)); run sync` : 'runtime present');
  const drift = G.runOps(root, plan, { dryRun: true });
  line(!drift.changed.length, drift.changed.length ? `out of sync: ${drift.changed.join(', ')}. Run sync.` : 'every assistant\'s files match .houserules/');
  drift.skipped.forEach(s => out(`  ..   left alone: ${s}`));
  plan.warnings.forEach(w => out(`  ..   ${w}`));
  const gh = hook.status(root);
  line(gh.installed, gh.installed ? 'pre-commit secret scan installed' : `pre-commit secret scan not installed${gh.reason ? ` (${gh.reason})` : ''}; run init`);

  out('\nHooks (each one is sent "rm -rf /" and must block it, and "git status" and must allow it)');
  for (const tool of plan.tools) {
    const t = selfTest(root, tool);
    if (!t) continue;
    line(t.ok, `${tool}: ${t.ok ? 'blocks dangerous commands, allows safe ones' : t.detail}`);
  }

  out('\nAssistants found on this computer');
  const found = detect();
  for (const tool of plan.tools) out(`  ${found[tool] ? 'yes ' : 'no  '}  ${tool}${found[tool] ? ` (${found[tool]})` : ''}`);
  out('\nOne-time steps (the assistants ask for these; House Rules cannot do them for you)');
  for (const tool of plan.tools) if (found[tool] && NEXT_STEPS[tool]) out(`  - ${NEXT_STEPS[tool]}`);
  out('  - ChatGPT (app): paste .houserules/out/chatgpt-instructions.md into Settings > Personalization > Custom instructions, or a Project\'s instructions.');
  out(problems ? `\n${problems} problem(s) found.` : '\nAll checks passed.');
  return problems ? 1 : 0;
}

function cmdCheck() {
  const root = findRoot();
  let fail = 0;
  const plan = G.buildPlan(root);
  if (plan.errors.length) { plan.errors.forEach(e => err('error: ' + e)); fail++; }
  const drift = G.runOps(root, plan, { dryRun: true });
  if (drift.changed.length) { err(`Out of sync with .houserules/ (run "houserules sync" and commit): ${drift.changed.join(', ')}`); fail++; }
  const files = trackedFiles(root);
  const allow = (plan.policy.secrets && plan.policy.secrets.allow) || [];
  const ignore = (plan.policy.secrets && plan.policy.secrets.ignorePaths) || [];
  const res = S.scanPaths(root, files || ['.'], allow, ignore);
  for (const f of files || []) if (S.forbiddenFile(f) && !S.ignored(f, ignore)) res.hits.push({ file: f, line: 0, id: 'forbidden-file', preview: 'secret-bearing file is tracked by git' });
  if (res.hits.length) { err('Possible secrets in tracked files:'); printHits(res.hits); fail++; }
  out(fail ? `House Rules check failed (${fail} problem group(s)).` : `House Rules check passed: in sync, policy valid, ${res.files} tracked file(s) scanned, no secrets.`);
  return fail ? 1 : 0;
}

function cmdExport(argv) {
  const what = argv[0];
  if (what !== 'chatgpt') { err('Usage: houserules export chatgpt'); return 1; }
  const root = findRoot();
  const { policy } = loadPolicy(root);
  const text = G.chatgptExport(root, policy);
  out(text);
  err(`\n(${text.length} characters. ChatGPT Custom Instructions allow 5,000 on paid plans and 1,500 on Free and Go; Project instructions apply only inside that Project.)`);
  return 0;
}

function main(argv) {
  const [cmd, ...rest] = argv;
  let code;
  switch (cmd) {
    case 'init': code = cmdInit(rest); break;
    case 'sync': code = cmdSync(rest); break;
    case 'doctor': code = cmdDoctor(rest); break;
    case 'check': code = cmdCheck(rest); break;
    case 'guard': code = cmdGuard(rest); break;
    case 'test': code = cmdTest(rest); break;
    case 'rules': code = cmdRules(rest); break;
    case 'scan': code = cmdScan(rest); break;
    case 'audit': code = cmdAudit(rest); break;
    case 'export': code = cmdExport(rest); break;
    case 'uninstall': code = cmdUninstall(rest); break;
    case 'version': case '--version': case '-v': out(VERSION); code = 0; break;
    case undefined: case 'help': case '--help': case '-h': out(HELP); code = 0; break;
    default: err(`Unknown command "${cmd}".\n`); out(HELP); code = 1;
  }
  process.exitCode = code;
  return code;
}

module.exports = { main, findRoot, cmdGuard };
