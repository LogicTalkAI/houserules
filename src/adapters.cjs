'use strict';
// Each assistant sends the command to its hook in a different shape and expects a different answer.
// Every tool listed here treats exit code 2 as "block", so a deny always exits 2 with the reason on stderr,
// and also prints the tool's own JSON answer. Sources: vendor docs, checked 2026-09-26 (see docs/TOOLS.md).

function parse(raw) { try { return raw && raw.trim() ? JSON.parse(raw) : {}; } catch { return {}; } }

// Returns the shell command the assistant wants to run, or null when the call is not a shell command.
function commandFrom(tool, input) {
  const i = input || {};
  const ti = i.tool_input || i.toolInput || {};
  if (tool === 'cursor') return typeof i.command === 'string' ? i.command : null;
  if (tool === 'copilot') {
    let args = i.toolArgs ?? i.tool_input ?? i.toolInput;
    if (typeof args === 'string') { try { args = JSON.parse(args); } catch { return args; } }
    if (args && typeof args === 'object') return args.command ?? args.cmd ?? args.script ?? null;
    return null;
  }
  // claude, codex, grok, gemini, vscode: { tool_name, tool_input: { command } }
  if (typeof ti.command === 'string') return ti.command;
  if (Array.isArray(ti.command)) return ti.command.join(' ');
  if (typeof ti.cmd === 'string') return ti.cmd;
  return null;
}

// Tools with a native "ask the person" answer. Everywhere else an "ask" rule blocks and tells the agent to ask.
const HAS_ASK = new Set(['claude', 'vscode']);

function answer(tool, verdict) {
  const { decision, rule, why } = verdict;
  if (decision === 'allow') return { code: 0, stdout: '', stderr: '' };
  const needsPerson = decision === 'ask';
  const reason = needsPerson
    ? `House Rules: "${rule}" needs a person's approval. ${why} Ask the user to approve or run it themselves.`
    : `House Rules blocked this command ("${rule}"). ${why} Do not retry it another way; tell the user what you wanted to do and why.`;
  if (needsPerson && HAS_ASK.has(tool)) {
    return { code: 0, stderr: '', stdout: JSON.stringify({ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'ask', permissionDecisionReason: reason } }) };
  }
  let out;
  if (tool === 'cursor') out = { permission: 'deny', user_message: reason, agent_message: reason };
  else if (tool === 'copilot') out = { permissionDecision: 'deny', permissionDecisionReason: reason, hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  else if (tool === 'gemini' || tool === 'grok') out = { decision: 'deny', reason };
  else out = { hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: reason } };
  return { code: 2, stdout: JSON.stringify(out), stderr: reason };
}

module.exports = { parse, commandFrom, answer, HAS_ASK };
