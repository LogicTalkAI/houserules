# Contributing

Thanks for helping. House Rules has no dependencies and aims to stay that way.

```bash
git clone https://github.com/LogicTalkAI/houserules
cd houserules
npm test
```

## Adding or changing a command rule

Rules live in `src/policy.cjs`. Every change needs test cases in `test/guard.test.cjs`: at least one command it must
catch and one everyday command it must not. False alarms make people turn guards off, so the "allowed" list matters as
much as the "blocked" list.

## Supporting a new assistant

1. Link the vendor's official documentation for its instruction file, hook format, and skills folder.
2. Add the input shape and answer to `src/adapters.cjs`, the files to `buildPlan` in `src/generate.cjs`, and a row to `docs/TOOLS.md`.
3. Add the assistant to the hook test in `test/e2e.test.cjs`, which runs the real hook command from a sub-folder.

## Before a pull request

- `npm test` passes on your system.
- Generated content never touches text outside House Rules' marked blocks.
- Plain words in anything a user reads.
