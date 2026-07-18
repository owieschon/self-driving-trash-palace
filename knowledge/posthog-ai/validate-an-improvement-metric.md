# Validate an improvement metric

This guide checks whether the duplicate-routine metric can distinguish a known failure from the corrected behavior before any live improvement claim is allowed.

Before you start, [instrument the agentic workflow](instrument-an-agentic-workflow.md) and understand [what each evidence artifact can prove](../concepts/evidence-and-improvement.md).

## Run the credential-free study

Install the pinned workspace, then run the retained report check:

```bash
pnpm install --frozen-lockfile
pnpm evidence:report --check
```

The command compares two pinned projections:

- The broken control creates more than one durable routine for one activation intent.
- The corrected projection preserves one logical operation and one active routine after a lost response.

## Check the result

The report must show different duplicate-routine rates while preserving the declared guardrails. The command exits nonzero when the fixture, calculation, threshold, or retained receipt drifts.

The broken control is part of the evaluator contract. If it produces the corrected outcome, the evaluator is defective rather than successful.

## Keep the claim bounded

This local study proves that the event contract and metric distinguish the known failure from the correction. It does not prove that PostHog ingested the events, that a live model behaved reliably, or that a deployed change improved customer outcomes.

A live self-improving loop still requires a real signal, investigation, reviewed change, delivery, and a declared post-change observation window.

## Next step

[Export analytics-safe evidence to PostHog](export-agent-evidence-to-posthog.md).
