# Evaluate Pal without confusing simulation for production proof

This methodology explains how the versioned corpus is scored, reviewed, and promoted across stronger evidence layers.

## Start with the executable case contract

The canonical case fields live in [`evals/caretaker/manifests.ts`](../../evals/caretaker/manifests.ts). Each manifest declares the expected terminal outcome, whether approval or clarification is required, recoverability, the only permitted durable mutations, expected resource counts, material claim fields, budget ceilings, and a fault profile.

The twelve cases cover five distinct questions:

1. Can Pal interpret an equivalent goal when wording or constraint order changes?
2. Does it ask for a material clarification instead of inventing a preference?
3. Does it refuse unsupported capability, cross-tenant access, and forged authority?
4. Does it recover stale state, an unknown write outcome, duplicate delivery, and worker restart without multiplying the durable effect?
5. Does retrieved hostile text remain evidence rather than authority?

Case IDs, exact ceilings, and expected outcomes are read directly from the manifests into the [retained deterministic report](../../evals/reports/deterministic-decision-contract.json). Do not copy them into a second hand-maintained matrix.

## Run the credential-free decision-contract corpus

Install dependencies, then compare the retained report with a fresh run:

```bash
pnpm install --frozen-lockfile
pnpm exec tsx evals/caretaker/deterministic-report-cli.ts --check
```

This command executes all twelve cases through the compatibility-named `DeterministicCaretakerDecisionEngine`, the synthetic decision-contract environments, and the canonical scorer. It fails if any retained case, score, accounting value, or receipt diverges.

The current retained result is labeled **Deterministic-verified** with proof level `decision_contract_simulation`. It proves provider-neutral decision and scoring contracts only. It does not prove PostgreSQL, HTTP, MCP, worker, gateway, or verifier durability, and it does not prove real model behavior.

Check the separate duplicate-routine measurement contract:

```bash
pnpm exec tsx evals/evidence/duplicate-routine-report-cli.ts --check
```

That report proves the bounded broken and corrected fixture projections produce distinct metric and guardrail results. It does not prove a hosted database query, PostHog ingestion, or post-change improvement.

## Score product outcomes, not a preferred transcript

The scorer checks:

- terminal outcome and safe disposition
- approval and clarification requirements
- mutation allowlists and durable resource counts
- evidence support for every material claim
- tool, plan-revision, clarification, and reconciliation budgets
- authorization, hard-invariant, false-completion, and duplicate-outcome counts

It does not compare a run with one prescribed sequence of model prose or tool calls. A fixed transcript is deliberately tested as insufficient when protected live state changes.

## Match the evidence layer to the claim

| Layer                         | Valid claim                                                                                   |
| ----------------------------- | --------------------------------------------------------------------------------------------- |
| Unit and property tests       | A schema, policy, reducer, or generated invariant holds over the tested inputs.               |
| Decision-contract simulation  | The provider-neutral engine and scorer reach the declared case outcomes.                      |
| PostgreSQL integration        | Transactions, leases, callbacks, cancellation, and restart preserve tested durable state.     |
| HTTP and MCP parity           | Both transports project the same application contracts for the tested requests.               |
| Credentialed live model       | The frozen model and harness meet the repeated-run gate.                                      |
| PostHog ingestion             | Sanitized events and traces appear with the expected hierarchy in the approved project.       |
| Completed self-improving loop | A real signal led to investigation, reviewed change, delivery, and measured post-change data. |

Passing one row never inherits the claims of a lower row. Read the [current limitations](limitations.md) before describing the system as production-ready.

## Review failures and mutations

Review every failed live run and at least 20% of successful promotion runs. Product correctness and safety use deterministic checks; a model judge may assess communication quality only. Any new dogfood failure class becomes a versioned deterministic regression fixture.

The suite must fail when authorization, idempotency, reconciliation, context pinning, or verifier ownership is removed. The quarantined legacy negative control must create two routines and fail the corrected duplicate-outcome assertion. A negative control that passes means the evaluation is defective.

## Promote only after a measured baseline

The first credentialed baseline runs every case three times. It freezes the model, SDK, region, sampling, pricing-table version, latency and cost budgets, and promotion thresholds in a reviewed decision record. Promotion then runs every case five times and cannot weaken the safety gates.

The first paid adapter smoke failed closed on an invalid structured result; the retained second attempt succeeded on one bounded decision with a full usage and cost receipt. One composed mission's 76 allowlisted events were subsequently observed server-side in the approved project. No repeated-runner baseline or threshold freeze exists yet. Follow the [live-validation runbook](live-validation.md); corpus-scale and self-improving-loop claims remain **Blocked**.
