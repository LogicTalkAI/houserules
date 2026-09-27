'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { scanText, redact, forbiddenFile } = require('../src/secrets.cjs');

// Keys are assembled at run time so this file never contains a string the scanner (or any other scanner) flags.
const K = {
  aws: 'AKIA' + 'IOSFODNN7EXAMPLE',                          // AWS's own documentation example
  github: 'ghp_' + 'a'.repeat(20) + 'B'.repeat(16),
  stripe: 'sk_' + 'live_' + '4eC39HqLyjWDarjtT1zdp7dc0000',
  anthropic: 'sk-' + 'ant-api03-' + 'x'.repeat(40),
  openai: 'sk-' + 'proj-' + 'y'.repeat(48),
  google: 'AIza' + 'Sy' + 'D'.repeat(33),
  pem: '-----BEGIN ' + 'RSA PRIVATE KEY-----',
  slack: 'xox' + 'b-123456789012-abcdefghij',
};

test('finds known key formats', () => {
  for (const [name, key] of Object.entries(K)) {
    const hits = scanText(`const x = "${key}";`, 'a.js');
    assert.equal(hits.length >= 1, true, name);
  }
});

test('reports file and line, never the full secret', () => {
  const [h] = scanText(`line one\nkey = ${K.stripe}\n`, 'cfg.js');
  assert.equal(h.file, 'cfg.js'); assert.equal(h.line, 2);
  assert.ok(!h.preview.includes(K.stripe));
  assert.ok(!redact(K.github).includes(K.github.slice(4, 30)));
});

test('ordinary code does not trigger it', () => {
  const code = [
    'const apiKey = process.env.OPENAI_API_KEY;', 'const sk = "sk-test";', 'const id = "AKIA";', 'password: ""',
    '// see https://platform.openai.com/api-keys', 'const token = crypto.randomUUID();', 'hash = "d41d8cd98f00b204e9800998ecf8427e"',
  ].join('\n');
  assert.equal(scanText(code, 'ok.js').length, 0);
});

test('inline allow marker and allow list silence a known false alarm', () => {
  assert.equal(scanText(`const demo = "${K.aws}"; // houserules:allow-secret`, 'a.js').length, 0);
  assert.equal(scanText(`const demo = "${K.aws}";`, 'a.js', ['EXAMPLE$']).length, 0);
});

test('secret-bearing file names are refused, examples are fine', () => {
  for (const f of ['.env', 'app/.env', '.env.production', '.dev.vars', 'id_rsa', 'certs/server.pem', 'credentials.json']) assert.equal(forbiddenFile(f), true, f);
  for (const f of ['.env.example', '.env.sample', 'env.ts', 'README.md', 'src/keys.ts']) assert.equal(forbiddenFile(f), false, f);
});
