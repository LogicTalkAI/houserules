'use strict';
// Decides whether a shell command may run: allow, ask (a person approves), or deny.
// The same decision is used by every assistant's hook; only the input and output shapes differ (see adapters.cjs).

// Split a command line into the parts a shell would run one after another, so "cd x && rm -rf /" is caught.
// Quotes are respected; this is a guard, not a full shell parser, so it errs toward checking more.
function splitCommand(cmd) {
  const parts = [];
  let cur = '', q = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i], n = cmd[i + 1];
    if (q) { cur += c; if (c === q && cmd[i - 1] !== '\\') q = null; continue; }
    if (c === '"' || c === "'") { q = c; cur += c; continue; }
    if ((c === '&' && n === '&') || (c === '|' && n === '|')) { parts.push(cur); cur = ''; i++; continue; }
    if (c === ';' || c === '\n') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts.map(s => s.trim()).filter(Boolean);
}

// Commands wrapped in another shell ("bash -c '...'", "powershell -Command ...", "cmd /c ...") and command
// substitutions ("$(...)", backticks, "<(...)") are unwrapped and checked too.
function innerCommands(cmd) {
  const out = [];
  const re = /\b(?:ba|z|da|k)?sh\s+-c\s+(["'])([\s\S]*?)\1|\b(?:pwsh|powershell)(?:\.exe)?\b[^"']*?-(?:c|Command)\s+(["'])([\s\S]*?)\3|\bcmd(?:\.exe)?\s+\/[ck]\s+(["']?)([\s\S]*?)\5(?=$|[;&|])|\$\(([^()]*)\)|`([^`]*)`|<\(([^()]*)\)|\beval\s+(["'])([\s\S]*?)\10/gi;
  let m;
  while ((m = re.exec(cmd))) out.push(m[2] || m[4] || m[6] || m[7] || m[8] || m[9] || m[11] || '');
  return out.filter(Boolean);
}

// Normalizes a command so rules see what actually runs:
// - leading "VAR=value" assignments and time/nice/nohup wrappers are dropped;
// - git's global options before the subcommand ("git -C dir", "git -c k=v", "--git-dir=...") are dropped, so
//   "git -C . push --force origin main" is judged as "git push --force origin main";
// - commit and tag messages are emptied, because their text never runs ("fix the git push -n bug").
function stripPrefixes(s) {
  return s
    .replace(/^(?:\s*[A-Za-z_][A-Za-z0-9_]*=(?:"[^"]*"|'[^']*'|\S*)\s+)+/, '')
    .replace(/^(?:time|nice(?:\s+-n\s+-?\d+)?|nohup)\s+/, '')
    .replace(/\bgit((?:\s+(?:-C\s+(?:"[^"]*"|'[^']*'|\S+)|-c\s+\S+|--(?:git-dir|work-tree|namespace|exec-path)(?:=|\s+)\S+|--no-pager|--paginate|-p|--bare|--no-replace-objects|--literal-pathspecs))+)(?=\s+[a-z])/g, 'git')
    .replace(/(\bgit\s+(?:commit|tag|merge|revert|notes\s+add)\b[^;&|]*?\s(?:-[a-zA-Z]*m|--message)(?:=|\s+))("(?:[^"\\]|\\.)*"|'[^']*')/g, '$1""');
}

const ORDER = { deny: 3, ask: 2, allow: 1 };

function compile(rule) {
  if (!rule._re) Object.defineProperty(rule, '_re', { value: new RegExp(rule.match, rule.flags || ''), enumerable: false });
  return rule._re;
}

// Returns { decision, rule, why, part }. Project "allow" rules that match a part exempt that part from the defaults.
function evaluate(command, policy) {
  const text = String(command || '');
  if (!text.trim()) return { decision: 'allow', rule: null, why: 'Empty command.' };
  const seen = new Set();
  const candidates = [];
  const add = s => { const t = stripPrefixes(s.trim()); if (t && !seen.has(t)) { seen.add(t); candidates.push(t); } };
  const whole = stripPrefixes(text.trim());
  add(text);
  const queue = [...new Set([text, whole])];
  for (let depth = 0; depth < 3 && queue.length; depth++) {
    const next = [];
    for (const c of queue) { splitCommand(c).forEach(add); innerCommands(c).forEach(inner => { add(inner); next.push(inner); }); }
    queue.splice(0, queue.length, ...next);
  }
  let best = { decision: 'allow', rule: null, why: 'No rule matched.' };
  for (const part of candidates) {
    const hits = policy.rules.filter(r => compile(r).test(part));
    if (!hits.length) continue;
    const exempt = hits.find(r => r.action === 'allow' && r.source === 'project');
    if (exempt && part !== candidates[0]) continue;             // a project allow rule covers this part
    if (exempt && part === candidates[0]) { if (best.decision === 'allow') best = { decision: 'allow', rule: exempt.id, why: exempt.why || 'Allowed by project rule.', part }; continue; }
    const worst = hits.filter(r => r.action !== 'allow').sort((a, b) => ORDER[b.action] - ORDER[a.action])[0];
    if (worst && ORDER[worst.action] > ORDER[best.decision]) best = { decision: worst.action, rule: worst.id, why: worst.why, part };
    if (best.decision === 'deny') break;
  }
  return best;
}

module.exports = { evaluate, splitCommand, innerCommands, stripPrefixes };
