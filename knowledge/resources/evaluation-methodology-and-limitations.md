# Evaluation methodology and limitations

This resource routes maintainers to the executable corpus, interpretation rules, and credential boundary without duplicating case metadata.

Before evaluating, understand [context authority](../concepts/context-authority.md), know [what evidence can prove](../concepts/evidence-and-improvement.md), and follow the [PostHog export boundary](../posthog-ai/export-agent-evidence-to-posthog.md).

- [Methodology](../../docs/evaluation/methodology.md) explains scoring, evidence layers, review, mutations, and promotion.
- [Limitations](../../docs/evaluation/limitations.md) records which broad claims are Pending, Blocked, Deferred, or out of scope.
- [Live-validation runbook](../../docs/evaluation/live-validation.md) defines the approval, budget, credential, and retained-evidence boundary.
- [Twelve-case report](../../evals/reports/deterministic-decision-contract.json) is the machine-readable decision-contract receipt.

Run the reproducible report check:

```bash
pnpm exec tsx evals/caretaker/deterministic-report-cli.ts --check
```

## Next step

[Look up the executable contracts](executable-contracts.md).
