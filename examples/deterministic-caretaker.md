# Run the deterministic Caretaker corpus

This example executes all twelve provider-neutral cases and checks the retained report.

```bash
pnpm exec tsx evals/caretaker/deterministic-report-cli.ts --check
```

For the complete scorer and mutation assertions, run the focused suite:

```bash
pnpm exec vitest run \
  evals/caretaker/deterministic-cases.test.ts \
  evals/caretaker/deterministic-report.test.ts
```

Expected scope: deterministic decision and scoring contracts. A passing result does not represent a model call, database transaction, network request, PostHog event, or self-improving loop.
