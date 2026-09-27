'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { commandFrom, answer } = require('../src/adapters.cjs');
const { upsertBlock, removeBlock } = require('../src/blocks.cjs');
const J = require('../src/jsonfile.cjs');

test('reads the command from each assistant\'s hook input', () => {
  const c = 'git status';
  assert.equal(commandFrom('claude', { tool_name: 'Bash', tool_input: { command: c } }), c);
  assert.equal(commandFrom('codex', { tool_name: 'Bash', tool_input: { command: c } }), c);
  assert.equal(commandFrom('gemini', { tool_name: 'run_shell_command', tool_input: { command: c } }), c);
  assert.equal(commandFrom('cursor', { command: c, cwd: '/x' }), c);
  assert.equal(commandFrom('copilot', { toolName: 'bash', toolArgs: JSON.stringify({ command: c }) }), c);
  assert.equal(commandFrom('copilot', { tool_name: 'Bash', tool_input: { command: c } }), c);
  assert.equal(commandFrom('claude', { tool_name: 'Read', tool_input: { file_path: 'a' } }), null);
});

test('a block always exits 2 with a reason (every tool treats 2 as block)', () => {
  for (const tool of ['claude', 'codex', 'gemini', 'cursor', 'copilot', 'grok']) {
    const a = answer(tool, { decision: 'deny', rule: 'rm-rf-root', why: 'x.' });
    assert.equal(a.code, 2, tool); assert.match(a.stderr, /blocked/, tool); assert.doesNotThrow(() => JSON.parse(a.stdout), tool);
  }
  assert.equal(JSON.parse(answer('cursor', { decision: 'deny', rule: 'r', why: 'x' }).stdout).permission, 'deny');
});

test('"ask" uses Claude Code\'s native prompt and blocks elsewhere', () => {
  const c = answer('claude', { decision: 'ask', rule: 'git-push', why: 'x.' });
  assert.equal(c.code, 0); assert.equal(JSON.parse(c.stdout).hookSpecificOutput.permissionDecision, 'ask');
  assert.equal(answer('codex', { decision: 'ask', rule: 'git-push', why: 'x.' }).code, 2);
  assert.equal(answer('claude', { decision: 'allow' }).code, 0);
});

test('managed blocks: added once, updated in place, removed cleanly', () => {
  const user = '# My project\n\nOur own notes.\n';
  const a = upsertBlock(user, 'rules v1');
  assert.equal(upsertBlock(a, 'rules v1'), a, 'idempotent');
  const b = upsertBlock(a, 'rules v2');
  assert.match(b, /rules v2/); assert.doesNotMatch(b, /rules v1/); assert.match(b, /Our own notes/);
  assert.equal(removeBlock(b), user);
  const top = upsertBlock('#!/bin/sh\necho hi\n', 'x', 'hash', 'top');
  assert.ok(top.startsWith('#!/bin/sh\n# houserules:begin'));
});

test('JSON merges keep the user\'s own entries', () => {
  const user = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'my-linter' }] }] }, permissions: { deny: ['Bash(sudo *)'] } };
  const ours = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node .houserules/runtime/houserules.cjs guard' }] };
  const merged = J.setNestedHook(user, 'PreToolUse', ours);
  assert.equal(merged.hooks.PreToolUse.length, 2);
  assert.deepEqual(J.setNestedHook(merged, 'PreToolUse', ours), merged, 'idempotent');
  assert.deepEqual(J.setNestedHook(merged, 'PreToolUse', null), user, 'removal restores');
  assert.deepEqual(J.setListEntries({ a: { b: ['x'] } }, 'a.b', ['y', 'x']), { a: { b: ['x', 'y'] } });
  assert.equal(J.hasComments('{ // note\n "a": 1 }'), true);
  assert.equal(J.hasComments('{ "url": "https://x.io" }'), false);
});
