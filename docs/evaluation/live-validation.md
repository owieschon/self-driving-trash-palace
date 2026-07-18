# Stop safely at the credentialed validation boundary

This runbook defines the approvals and evidence required before any paid model request or PostHog export.

## Current state

One bounded Claude adapter decision is **Credentialed-decision-verified**. The [current receipt](../../evals/reports/claude-live-smoke.json) records Claude Sonnet 4.6 selecting the request-allowed `palaces.get` tool with one request-bound evidence reference. It retains exact usage, duration, and cost without retaining the credential, prompt, raw output, private reasoning, customer data, or identifier-shaped evidence values. The adapter gives Claude a request-bound schema simplified to Anthropic's supported grammar and then validates the result against the complete Zod and host contracts. The SDK's internal `StructuredOutput` pseudo-tool is the only permitted exception to the empty model tool surface. Earlier bounded attempts failed closed; the [first attempt](../../evals/reports/claude-live-smoke-attempt1.json) is retained, while overwritten intermediate attempts cannot support claims. One success does not establish corpus accuracy, production-composed behavior, latency baselines, or provider stability. A completed self-improving loop remains **Blocked**.

PostHog ingestion is **Ingestion-verified** at two levels. The [synthetic transport receipt](../../evals/reports/posthog-ingestion-live.json) records a content-free product event and correlated AI span/trace pair observed server-side. The separate [composed product-path receipt](../../evals/reports/posthog-product-path-live.json) records all 76 allowlisted events from one Scheduled Hauler Access evaluation mission observed in the approved US project: 74 spans, one terminal trace, and one mission event, each with a unique insert ID. Neither receipt proves production traffic or a completed improvement loop. The earlier [blocked receipt](../../evals/reports/live-validation-blocked.json) remains the pre-authorization snapshot.

Each ingestion command and its committed receipt represent two phases of one verification. A CLI can prove that it submitted an allowlisted batch, so it first emits `awaiting_server_verification` with `serverObservation: null`. It cannot observe PostHog's server-side event store. A separate PostHog MCP query checks the retained insert IDs, event counts, organization alias, and trace correlation; only that observation upgrades the retained receipt to `verified`. Preserve the two receipts as separate evidence because the synthetic batch proves transport correctness while the composed batch proves product-path integration.

The repository implements the case catalog, promotion scorer, fail-closed preflight, and generic
runner contract. It does not implement the credentialed production case executor or its invocation
command. Do not substitute deterministic output, replayed responses, or mocks for a credentialed
baseline.

## Run the non-network preflight

The preflight reads presence and approval flags only. It never emits secret values and returns exit
code `2` while the credentialed production executor is absent.

```bash
pnpm exec tsx evals/live/preflight.ts baseline
pnpm exec tsx evals/live/preflight.ts promotion
pnpm exec tsx evals/live/preflight.ts posthog-ingestion
```

The structured result must remain `Blocked` with `networkRequestsMade: 0`. Exit code `1` means the command itself was malformed; exit code `2` is the expected credential-boundary result.

## Obtain separate authorization

Before implementing or invoking a paid runner, record all of the following without putting a credential value in a repository artifact:

1. Explicit operator approval for the named run and environment.
2. A maximum spend for that run.
3. The selected model, SDK, region, sampling configuration, and pricing-table version.
4. A fictional fixture-only data policy and retention location.
5. For PostHog, the approved project, Cloud region, project token injection path, and analytics-alias secret injection path.

An Anthropic API key authorizes model requests only. PostHog export requires a separate `phc_` project token. A personal PostHog API key is not accepted by the exporter.

## Required runner interface

No baseline or promotion execution command exists yet. That absence is deliberate and is a blocker,
not an invitation to call the SDK ad hoc. The production executor must preserve these interfaces:

| Mode      | Required behavior                                                                                               |
| --------- | --------------------------------------------------------------------------------------------------------------- |
| Baseline  | Run all 12 manifests three times and retain sanitized per-run receipts; never treat this as a promotion result. |
| Promotion | Refuse until a reviewed baseline decision freezes thresholds, then run every manifest five times.               |
| Ingestion | Export only allowlisted evidence and require server-side confirmation before changing the claim label.          |

The runner must abort before its first request when approval, budget, model configuration, fixture isolation, receipt storage, or redaction checks are missing. It must also stop at the declared spend or runtime ceiling.

## Retain evidence without publishing secrets

Retain sanitized trace, context receipt, plan and approval bindings, tool and operation receipts, verifier assertions, latency, token count, cost, and evaluator output. Never retain raw credentials, authorization headers, private prompts, private PostHog links, customer data, usernames, or home-directory paths.

Review every failure and a sampled 20% of successful promotion runs. Freeze promotion thresholds only after the baseline is measured. The retained PostHog receipt proves only transport, sanitization, server-side arrival, and trace correlation for its named evaluation batch. The self-improving loop remains **Blocked** until a real post-change observation window closes.
