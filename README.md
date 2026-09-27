# House Rules

**One rulebook for every AI coding assistant.** Write your team's rules, skills, and guardrails once. Claude Code,
OpenAI Codex, GitHub Copilot, Cursor, Gemini CLI, and Grok Build all follow them, and a command guard and a secret
scan enforce the parts that matter.

```bash
npx github:LogicTalkAI/houserules init
node .houserules/runtime/houserules.cjs doctor
```

Two commands. No accounts, no server, no dependencies. Works in VS Code and anywhere these assistants run.

---

## Why

Every AI coding assistant reads its own files: `CLAUDE.md`, `AGENTS.md`, `.cursor/rules`, `.github/copilot-instructions.md`,
`.gemini/settings.json`, `.codex/config.toml`. Teams that use more than one end up with rules that drift apart, and
rules written as text are only requests. An assistant can still run `rm -rf ~`, print your `.env`, or push to `main`.

House Rules keeps one source in `.houserules/` and does two jobs:

1. **Sync.** It writes each assistant's native files from that source, inside clearly marked blocks, so your own
   content in those files stays untouched.
2. **Enforce.** It installs a hook in every assistant that checks each shell command before it runs (block, ask a
   person, or allow), and a git pre-commit scan that stops API keys from being committed, whoever wrote the code.

## What each assistant gets

| Assistant | Instructions | Command guard | Skills |
|---|---|---|---|
| Claude Code | `CLAUDE.md` imports `AGENTS.md` | `PreToolUse` hook in `.claude/settings.json`, plus read/edit deny rules for secret files | `.claude/skills/` |
| OpenAI Codex | `AGENTS.md` | `PreToolUse` hook in `.codex/hooks.json`; `.codex/config.toml` sets `approval_policy = "on-request"`, `sandbox_mode = "workspace-write"` | `.agents/skills/` |
| GitHub Copilot | `AGENTS.md` (turned on in `.vscode/settings.json`) | `preToolUse` hook in `.github/hooks/houserules.json` | `.agents/skills/`, `.claude/skills/` |
| Cursor | `AGENTS.md` | `beforeShellExecution` hook in `.cursor/hooks.json` | `.agents/skills/` |
| Gemini CLI | `AGENTS.md` (added to `context.fileName`) | `BeforeTool` hook in `.gemini/settings.json` | `.agents/skills/` |
| Grok Build | `AGENTS.md`, `CLAUDE.md` | `PreToolUse` hook in `.grok/hooks/houserules.json` | `.claude/skills/` |
| VS Code | | | Suggests each assistant's extension; adds "House Rules" tasks |
| ChatGPT (app) | `.houserules/out/chatgpt-instructions.md`, sized for Custom Instructions | Not possible (no hooks in the app) | |

Windsurf reads `AGENTS.md` too. Every file format above was checked against the vendor's own documentation;
see [docs/TOOLS.md](docs/TOOLS.md) for sources.

## Quick start

In the root of any project (a git repository is best, so the secret scan can run):

```bash
npx github:LogicTalkAI/houserules init            # all assistants
npx github:LogicTalkAI/houserules init --tools claude,codex   # only some
```

Then prove it works:

```bash
node .houserules/runtime/houserules.cjs doctor
```

`doctor` sends every assistant's hook a dangerous command (`rm -rf /`) and a safe one (`git status`) and reports
whether each one blocked and allowed correctly. It also lists the one-time approvals each assistant asks for the first
time it sees project hooks. Those approvals are a security feature of the assistants; House Rules cannot click them for you.

Commit `.houserules/` and the generated files. Teammates get the same rules and guards when they pull, with nothing to install.

## Your rules, in plain words

`.houserules/rules.md` is ordinary Markdown. Say how you want assistants to work, then run:

```bash
node .houserules/runtime/houserules.cjs sync
```

Every assistant's files update. The starter file covers working style, safety, and how to report back; edit it freely.

## Guardrails

Built-in command rules (list them any time with `houserules rules`):

- **Blocked:** recursive delete of `/`, `~`, `*` or `.`; PowerShell equivalents; disk formatting; fork bombs;
  `chmod -R 777`; piping a download into a shell (`curl … | bash`, `irm … | iex`); printing `.env`, private keys or
  credential files; dumping all environment variables; echoing a variable named like a key or token; `--no-verify`
  on commits and pushes; force-pushing `main`, `master` or `production`.
- **Needs a person:** `git push`, force push, `git reset --hard`, `git clean -f`, recursive deletes, publishing and
  deploying (npm, Wrangler, Vercel, Netlify, Firebase, Fly, Terraform, Pulumi, kubectl, Helm, Docker, GitHub releases,
  and more), deleting cloud resources, `DROP TABLE`, `sudo`.
- **Protected files:** `.env*`, `.dev.vars`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, SSH keys, `credentials.json`, `secrets.*`.

Chained and wrapped commands are checked part by part, so `npm test && rm -rf ~` and `bash -c 'rm -rf /'` are caught.
Claude Code shows its own approval prompt for "needs a person" commands; the other assistants are told to stop and ask you.

Try a command without running it:

```bash
node .houserules/runtime/houserules.cjs test "git push --force origin main"
# DENY  (git-force-push-main)  Force-pushes over the main branch, erasing other people's work.
```

## Customize

`.houserules/policy.json`:

```json
{
  "version": 1,
  "tools": "auto",
  "disable": ["git-push"],
  "rules": [
    { "id": "no-prod-db", "action": "deny", "match": "\\bprod-db\\b", "why": "Never touch the production database." },
    { "id": "clean-dist", "action": "allow", "match": "^rm -rf dist$", "why": "Build output is safe to delete." }
  ],
  "protectedPaths": ["config/master.key"],
  "secrets": { "scanOnCommit": true, "allow": ["^AKIA0000"], "ignorePaths": ["vendor/", "test/fixtures/"] }
}
```

- `tools`: `"auto"` for every supported assistant, or a list such as `["claude", "codex", "vscode"]`.
- `disable`: turn off built-in rules by id.
- `rules`: your own. `deny` blocks, `ask` needs a person, `allow` makes an exception. An exception for one part of a
  chained command never excuses another part.
- `protectedPaths`: extra files assistants must not read or edit.
- `secrets.allow`: patterns for known false alarms; `secrets.ignorePaths`: folders to skip (vendored code, scraped
  pages, fixtures). You can also put `houserules:allow-secret` in a comment on a line. Obvious placeholders such as
  `sk-ant-your-key-here` or `...EXAMPLE` are never reported.

**Skills** go in `.houserules/skills/<name>/SKILL.md` using the open [Agent Skills](https://agentskills.io/specification)
format (`name` matching the folder, and a `description`). House Rules copies them to `.claude/skills/` and
`.agents/skills/`, which between them reach all six assistants. A starter `safe-change` skill is included.

## Commands

| Command | What it does |
|---|---|
| `init [--tools a,b] [--no-git-hook] [--no-sample-skill]` | Set up (safe to run again). |
| `sync` | Rewrite every assistant's files after you edit `.houserules/`. |
| `doctor` | Check setup and prove every hook blocks and allows correctly. |
| `check` | For CI: fails if files are out of sync, the policy is invalid, or a tracked file holds a secret. |
| `rules` | List the command rules in force. |
| `test "<command>"` | Show the decision for a command without running it. |
| `scan [--staged] [paths]` | Look for secrets. |
| `audit` | Show recent blocked or held commands (kept locally in `.houserules/audit.log`, not committed). |
| `export chatgpt` | Print your rules condensed for ChatGPT. |
| `uninstall [--all]` | Remove everything House Rules added. Your own content stays. |

Run any of them as `node .houserules/runtime/houserules.cjs <command>`, or `npx github:LogicTalkAI/houserules <command>`.
In VS Code: **Terminal > Run Task > House Rules**.

## In CI

```yaml
# .github/workflows/houserules.yml
name: House Rules
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 20 }
      - run: node .houserules/runtime/houserules.cjs check
```

## ChatGPT

The ChatGPT app has no hooks, so House Rules cannot enforce anything there. It can make sure ChatGPT knows your rules:
`houserules export chatgpt` prints them condensed (the file is also kept at `.houserules/out/chatgpt-instructions.md`).
Paste it into **Settings > Personalization > Custom instructions** (5,000 characters on paid plans, 1,500 on Free and Go)
or into a ChatGPT Project's instructions.

## How safe is this?

House Rules is a strong safety net, not a sandbox. Know its limits:

- **Hooks run only after you approve them.** Codex, Grok, and Claude Code ask you to trust a project's hooks the first
  time. Until then, the guard does not run. `doctor` lists these steps.
- **Most assistants let a command through if a hook crashes** (Grok, Gemini, Cursor, VS Code fail open; Copilot's CLI
  fails closed). House Rules is built to always answer, and `doctor` tests that it does.
- **Pattern checks can be sidestepped** by a determined or confused agent (a new script file, an unusual shell).
  Keep each assistant's own approval and sandbox settings on; House Rules adds to them, it does not replace them.
- **The secret scan knows published key formats** (AWS, GitHub, Stripe, OpenAI, Anthropic, xAI, Google, Slack, npm,
  SendGrid, Twilio, private keys) and refuses `.env` and key files. A secret with no recognizable format can still get through.
- **Nothing leaves your machine.** No network calls, no telemetry. The audit log stays local and redacts anything
  that looks like a key.

Found a way around a guard? See [SECURITY.md](SECURITY.md).

## Uninstall

```bash
node .houserules/runtime/houserules.cjs uninstall        # keeps your rules in .houserules/
node .houserules/runtime/houserules.cjs uninstall --all  # removes that too
```

Marked blocks come out of shared files, House Rules' entries come out of JSON settings, files it created are deleted,
and settings it changed go back to what they were.

## Requirements

Node.js 18 or newer, and Git for the secret scan. Built for Windows, macOS, and Linux; CI runs the full test suite
on all three with Node 18, 20, and 22.

## License

Apache-2.0. Made by [Logic Talk AI](https://logictalk.ai). Contributions welcome: see [CONTRIBUTING.md](CONTRIBUTING.md).
