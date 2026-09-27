# Tool formats and sources

Every file House Rules writes follows the vendor's own documentation, read on **2026-09-26**. Assistants change often;
if one changes a format, open an issue with a link to the new docs.

| Assistant | What House Rules writes | How a hook blocks | Source |
|---|---|---|---|
| Claude Code | `CLAUDE.md` with `@AGENTS.md` import; `.claude/settings.json` `hooks.PreToolUse` (matcher `Bash\|PowerShell`) and `permissions.deny` `Read(...)`/`Edit(...)`; `.claude/skills/<name>/SKILL.md` | Exit 2 with reason on stderr, or `hookSpecificOutput.permissionDecision` `deny`/`ask` | code.claude.com/docs/en/memory, /permissions, /hooks, /skills |
| OpenAI Codex | `AGENTS.md`; `.codex/hooks.json` `PreToolUse` (matcher `Bash`); `.codex/config.toml` `approval_policy`, `sandbox_mode`; `.agents/skills/` | Exit 2 with reason on stderr, or `permissionDecision: "deny"` | learn.chatgpt.com/docs/agent-configuration/agents-md, /config-file/config-reference, /hooks, /build-skills |
| GitHub Copilot | `.github/hooks/houserules.json` (`version: 1`, `preToolUse`, `bash` and `powershell` commands); `.vscode/settings.json` `chat.useAgentsMdFile: true` | `permissionDecision: "deny"`; exit 2 or any non-zero exit denies in the CLI | docs.github.com/en/copilot/reference/hooks-reference; code.visualstudio.com/docs/agents/reference/hooks-reference |
| Cursor | `.cursor/hooks.json` (`version: 1`, `beforeShellExecution`) | `{"permission": "deny"}` or exit 2 | cursor.com/docs/agent/hooks, /context/rules, /context/skills |
| Gemini CLI | `.gemini/settings.json` `context.fileName` including `AGENTS.md`; `hooks.BeforeTool` (matcher `run_shell_command`, timeout in ms) | `"decision": "deny"` or exit 2 | geminicli.com/docs/cli/gemini-md, /hooks/reference, /reference/configuration, /cli/skills |
| Grok Build (xAI) | `.grok/hooks/houserules.json` (`PreToolUse`, matcher `Bash`, also matched to `run_terminal_command`) | `{"decision": "deny"}`, `hookSpecificOutput`, or exit 2 | docs.x.ai/build/overview; the user guide shipped with the CLI (`~/.grok/docs`) |
| Agent Skills | `name` (1-64 lowercase letters, digits, single hyphens, equal to the folder), `description` (1-1024 chars) | | agentskills.io/specification |
| AGENTS.md | One Markdown file; nearest wins | | agents.md |

## Notes that shaped the design

- **One hook command for all tools.** It finds `.houserules/runtime/` by walking up from the folder the assistant runs
  it in, so it works from sub-folders and in bash, PowerShell, and cmd without environment variables.
- **Exit code 2 everywhere.** Every assistant above treats exit 2 as "block", so a deny always exits 2 and also prints
  the tool's own JSON answer.
- **Fail-open tools.** Grok, Gemini, Cursor, and VS Code let a command through when a hook errors. The guard catches
  its own errors, and `doctor` proves each hook answers.
- **Trust prompts.** Codex loads project config and hooks only for trusted projects and asks you to review each hook;
  Grok needs `/hooks-trust`; Claude Code applies workspace trust.
- **Size limits.** Codex stops reading instruction files at 32 KiB in total. One Grok document caps each file at
  10,000 characters and another says there is no cap; House Rules warns when its `AGENTS.md` block passes 9,000.
- **Cursor** ignores plain `.md` files in `.cursor/rules/`; it reads `AGENTS.md`, so House Rules writes no Cursor rule file.
- **ChatGPT app:** Custom Instructions hold 5,000 characters on paid plans and 1,500 on Free and Go (help.openai.com,
  article 8096356). The Project instructions limit is not documented.
