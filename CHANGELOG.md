# Changelog

## 1.0.0 (2026-09-26)

First release.

- One source (`.houserules/`) for rules, command policy, and skills.
- Generates native files for Claude Code, OpenAI Codex, GitHub Copilot, Cursor, Gemini CLI, Grok Build, and VS Code,
  plus a ChatGPT instructions export.
- Command guard hook for all six assistants: 19 built-in rules (block or ask), project rules, exceptions, audit log.
- Pre-commit secret scan for 13 key formats and secret-bearing files.
- `doctor` proves each hook blocks and allows; `check` for CI; clean `uninstall`.
