'use strict';
// Finds credentials before they are committed, whichever assistant (or person) wrote the code.
// Patterns use each provider's published key prefix, so they rarely fire on ordinary text. They are a safety net,
// not a guarantee: a key without a known prefix can still slip through.
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const PATTERNS = [
  { id: 'private-key', re: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP |ENCRYPTED )?PRIVATE KEY(?: BLOCK)?-----/ },
  { id: 'aws-access-key-id', re: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/ },
  { id: 'github-token', re: /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{36,}\b|\bgithub_pat_[A-Za-z0-9_]{50,}\b/ },
  { id: 'slack-token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/ },
  { id: 'stripe-live-key', re: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}\b/ },
  { id: 'stripe-webhook-secret', re: /\bwhsec_[A-Za-z0-9+/=]{24,}\b/ },
  { id: 'anthropic-key', re: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{40,}/ },
  { id: 'openai-key', re: /\bsk-(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|\bsk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}\b/ },
  { id: 'xai-key', re: /\bxai-[A-Za-z0-9]{40,}\b/ },
  { id: 'google-api-key', re: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { id: 'npm-token', re: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { id: 'sendgrid-key', re: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/ },
  { id: 'twilio-key', re: /\bSK[0-9a-fA-F]{32}\b/ },
];

// Files that should never be committed at all, whatever they contain.
const FORBIDDEN_FILES = [/(^|\/)\.env$/, /(^|\/)\.env\.(?!example$|sample$|template$|dist$)[\w.-]+$/, /(^|\/)\.dev\.vars$/, /(^|\/)id_(?:rsa|dsa|ecdsa|ed25519)$/, /\.(?:pem|p12|pfx|key)$/i, /(^|\/)credentials\.json$/];

const ALLOW_MARK = 'houserules:allow-secret';
const MAX_BYTES = 1024 * 1024;
// Documentation placeholders ("sk-ant-your-key-here", "...EXAMPLE", "xxxxxxxx") are not secrets.
const PLACEHOLDER = /example|sample|placeholder|your[_-]?(?:api[_-]?)?(?:key|token|secret)|replace[_-]?me|change[_-]?me|dummy|fake|redacted|x{6,}|\.{3}|<|>/i;

function scanText(text, file = '', allow = []) {
  const hits = [];
  const allowRes = allow.map(a => { try { return new RegExp(a); } catch { return null; } }).filter(Boolean);
  const lines = String(text).split(/\r?\n/);
  lines.forEach((line, i) => {
    if (line.includes(ALLOW_MARK)) return;
    for (const p of PATTERNS) {
      const m = line.match(p.re);
      if (!m || PLACEHOLDER.test(m[0]) || allowRes.some(a => a.test(m[0]))) continue;
      hits.push({ file, line: i + 1, id: p.id, preview: redact(m[0]) });
    }
  });
  return hits;
}

// secrets.ignorePaths: folder or file prefixes to skip (vendored code, scraped pages, fixtures).
function ignored(rel, ignorePaths = []) {
  const r = rel.replace(/\\/g, '/').replace(/^\.\//, '');
  return ignorePaths.some(p => { const q = String(p).replace(/\\/g, '/').replace(/^\.\//, ''); return q && (r === q.replace(/\/$/, '') || r.startsWith(q.endsWith('/') ? q : q + '/')); });
}

// Never print a found secret back to the terminal (terminals are logged and screen-shared).
function redact(s) { return s.length <= 8 ? '****' : `${s.slice(0, 4)}…${s.slice(-2)} (${s.length} chars)`; }

function forbiddenFile(rel) { return FORBIDDEN_FILES.some(re => re.test(rel.replace(/\\/g, '/'))); }

function git(args, cwd) { return execFileSync('git', args, { cwd, encoding: 'buffer', stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }); }

// Scans what is about to be committed (the staged version of each file, not the working copy).
function scanStaged(root, allow = [], ignorePaths = []) {
  let names = [];
  try { names = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'], root).toString('utf8').split('\0').filter(Boolean); }
  catch { return { hits: [], files: 0, error: 'Not a git repository, or git is not installed.' }; }
  const hits = [];
  for (const rel of names) {
    if (ignored(rel, ignorePaths)) continue;
    if (forbiddenFile(rel)) { hits.push({ file: rel, line: 0, id: 'forbidden-file', preview: 'this kind of file holds secrets; add it to .gitignore' }); continue; }
    let buf;
    try { buf = git(['show', `:${rel}`], root); } catch { continue; }
    if (buf.length > MAX_BYTES || buf.includes(0)) continue;   // large or binary
    hits.push(...scanText(buf.toString('utf8'), rel, allow));
  }
  return { hits, files: names.length };
}

// Scans files on disk (for "houserules scan <paths>" and CI). Skips .git, node_modules, and binary/large files.
function scanPaths(root, targets, allow = [], ignorePaths = []) {
  const hits = [];
  let files = 0;
  const skip = new Set(['.git', 'node_modules', '.houserules', 'dist', 'build', '.next', '.wrangler', 'coverage']);
  const walk = p => {
    let st; try { st = fs.statSync(p); } catch { return; }
    if (st.isDirectory()) { if (skip.has(path.basename(p))) return; for (const f of fs.readdirSync(p)) walk(path.join(p, f)); return; }
    if (!st.isFile() || st.size > MAX_BYTES) return;
    const rel = path.relative(root, p).replace(/\\/g, '/');
    if (ignored(rel, ignorePaths)) return;
    const buf = fs.readFileSync(p);
    if (buf.includes(0)) return;
    files++;
    hits.push(...scanText(buf.toString('utf8'), rel, allow));
  };
  (targets.length ? targets : ['.']).forEach(t => walk(path.resolve(root, t)));
  return { hits, files };
}

module.exports = { PATTERNS, FORBIDDEN_FILES, ALLOW_MARK, PLACEHOLDER, scanText, scanStaged, scanPaths, redact, forbiddenFile, ignored };
