# Security

House Rules is a guard for AI coding assistants, so a way around it is a security bug.

## Report a problem

Email **franco@logictalk.ai** with "House Rules security" in the subject. Include the command or file that got through,
the assistant and version, and your operating system. Please do not open a public issue for a bypass until a fix is out.
We aim to reply within one week.

## In scope

- A command that the default rules should block or hold (see `houserules rules`) but that the guard allows.
- A hook that fails to block when `doctor` says it works.
- A secret in one of the documented formats that the pre-commit scan misses.
- Anything that makes House Rules change files outside its marked blocks, tracked JSON entries, or its own files.

## Out of scope

- An assistant running a command before you have approved its project hooks (a trust step the assistant requires).
- Commands the default rules do not claim to cover. Suggest a new rule instead.
- Secrets with no recognizable format.

## Design

No network access, no telemetry, no dependencies. The runtime copied into each project is plain JavaScript you can read
in `.houserules/runtime/`.
