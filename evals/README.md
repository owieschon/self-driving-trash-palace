# Evaluation suite

This directory owns versioned scenarios, executable scorers, and retained run receipts.

## Check the deterministic corpus

```bash
pnpm exec tsx evals/caretaker/deterministic-report-cli.ts --check
```

The command runs all twelve manifests and compares the result with [`reports/deterministic-decision-contract.json`](reports/deterministic-decision-contract.json). Its proof level is `decision_contract_simulation`, not full-stack or live-model validation.

## Check the duplicate-routine measurement

```bash
pnpm exec tsx evals/evidence/duplicate-routine-report-cli.ts --check
```

This command compares the bounded broken and corrected fixture projections and verifies the retained [`reports/duplicate-routine-controls.json`](reports/duplicate-routine-controls.json). It validates the local metric and guardrail contract. It does not represent a PostHog query or a live observation window.

## Check the credential boundary

```bash
pnpm exec vitest run evals/live/readiness.test.ts
```

The retained [`reports/live-validation-blocked.json`](reports/live-validation-blocked.json) must reconcile with the fail-closed preflight. Read the [evaluation methodology](../docs/evaluation/methodology.md), [limitations](../docs/evaluation/limitations.md), and [live-validation runbook](../docs/evaluation/live-validation.md) before assigning a broader label.

## Run the composed Quest

Start from a clean local database and execute the public HTTP and MCP path:

```bash
pnpm local:prepare
pnpm local:reset
pnpm local:up
pnpm quest:verify
pnpm local:down
```

The command retains `reports/credential-free-quest.json` only after the mission succeeds, deterministic verification passes, and the current mission's transactional product-evidence deliveries appear exactly once in the safe local sink. This is a live local network simulation with a deterministic Caretaker and simulated gateway. It is not model-backed evidence, a real-device result, a PostHog ingestion receipt, or proof of runtime egress isolation.

Gateway fault manifests in `integration/` test the external-device boundary. Caretaker manifests in `caretaker/` test decision and outcome contracts. Keep those boundaries separate from the lab-only application commit-then-response-lost negative control.
