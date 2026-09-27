'use strict';
// Starter content for `houserules init`. Kept in code (not separate files) so the runtime copied into a project
// is self-contained and needs nothing from npm to run.

const RULES_MD = `# How we work with AI assistants
<!-- Edit this file in plain words. Run "node .houserules/runtime/houserules.cjs sync" to send the change to every
assistant. Lines inside comments like this one are not sent. -->

## Working style
- Read the relevant code before changing it. Follow the patterns and naming already used here.
- Keep each change small and focused on the task. Do not reformat or rename unrelated code.
- Before a large or risky change, write a short plan and wait for approval.
- Run the tests (or the closest check that exists) after a change, and say plainly whether they passed.
- If you are not sure how something works, say so and check. Never invent an API, file, setting, or number.

## Safety
- Never put secrets (API keys, passwords, tokens, private keys) in code, commits, logs, or chat. Use environment
  variables or the team's secret manager.
- Ask before anything that is hard to undo or reaches outside this computer: pushing, deploying, publishing,
  deleting data, sending messages, or spending money.
- If a House Rules check blocks a command, do not work around it. Stop and explain what you wanted to do.

## When you finish
- Summarize what changed, what you tested, and anything left undone.
`;

const POLICY_JSON = {
  version: 1,
  tools: 'auto',
  disable: [],
  rules: [],
  protectedPaths: [],
  secrets: { scanOnCommit: true, allow: [], ignorePaths: [] },
};

const README_MD = `# .houserules

This folder is the one place your team's AI rules live. House Rules turns it into the files each assistant reads
(AGENTS.md, CLAUDE.md, hook settings, skills) and keeps them in sync.

| File | What it is |
|---|---|
| rules.md | How assistants should work here, in plain words. |
| policy.json | Which tools to set up, which built-in command rules to switch off, your own rules, files to protect, secret-scan exceptions. |
| skills/ | Skills every assistant can use (each is a folder with a SKILL.md). |
| runtime/ | The small House Rules program the hooks run. Generated; do not edit. Commit it so teammates need nothing installed. |
| state.json | What House Rules added to shared settings files, so it can update or remove exactly that. Generated. |
| out/chatgpt-instructions.md | Rules condensed for ChatGPT's Custom Instructions or a ChatGPT Project. Generated. |

After editing anything here, run: \`node .houserules/runtime/houserules.cjs sync\`
Check everything is working: \`node .houserules/runtime/houserules.cjs doctor\`
`;

const SKILL_SAFE_CHANGE = `---
name: safe-change
description: Make a code change the careful way (read, plan, edit, test, report). Use for any change that touches more than one file, changes behavior, or could break something.
---

# Safe change

1. **Read first.** Open the files involved and the tests that cover them. Note the existing patterns.
2. **Plan.** Write 3 to 5 bullets: what will change, in which files, and how you will check it. For risky changes,
   stop here and ask for approval.
3. **Edit.** Make the smallest change that does the job. Match the surrounding style.
4. **Check.** Run the tests or the nearest available check. If none exist, say so and describe how you verified it.
5. **Report.** In plain words: what changed, what you ran and its result, and anything left to do.

Never skip step 4 silently. Never claim something works without having checked it.
`;

module.exports = { RULES_MD, POLICY_JSON, README_MD, SKILL_SAFE_CHANGE };
