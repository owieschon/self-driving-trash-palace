# Improve your first automation

This guide runs the credential-free improvement study for a duplicate-routine failure and explains exactly what the result proves.

Prerequisite: [start here](start-here.md), then install the pinned workspace from the repository root:

```bash
pnpm install --frozen-lockfile
```

## Run the study

From the repository root:

```bash
pnpm evidence:report --check
```

The command compares a pinned broken projection with a corrected projection. The broken case creates more than one durable routine for one activation intent. The corrected case preserves one logical operation and one active routine through a lost response.

## Observe the result

The report must show different duplicate-routine rates for the two projections while preserving the declared guardrails. The command exits nonzero when the fixture, calculation, threshold, or retained receipt drifts.

This is a local executable PostHog-shaped study. It proves the event contract and metric query distinguish the known failure from the correction. It does not prove that PostHog ingested events, that a live model behaved well, or that a deployed change improved real customer outcomes.

## Continue through the real loop

A live self-improving loop still requires a real signal, investigation, reviewed change, deployment, and a declared post-change observation window. Follow [evidence and improvement](../concepts/evidence-and-improvement.md), then [instrument the workflow](../posthog-ai/instrument-an-agentic-workflow.md).

## Next step

[Run TrashPal locally](run-locally.md).
