# Know what the current evidence does not prove

This page sets the claim boundary for the retained pre-visual, pre-deployment evidence.

## Current claim ledger

| Claim                                                        | Status                 | Evidence or missing evidence                                                                              |
| ------------------------------------------------------------ | ---------------------- | --------------------------------------------------------------------------------------------------------- |
| Twelve provider-neutral decision cases meet their manifests  | Deterministic-verified | [Executable retained report](../../evals/reports/deterministic-decision-contract.json)                    |
| Broken and corrected fixtures discriminate the local metric  | Deterministic-verified | [Executable duplicate-routine report](../../evals/reports/duplicate-routine-controls.json)                |
| The complete composed network Quest passes from a clean host | Network-verified       | [Credential-free Quest receipt](../../evals/reports/credential-free-quest.json)                           |
| Real model project discovery and tool choice are reliable    | Blocked                | Requires approved credentials, a paid budget, a frozen configuration, and repeated live runs              |
| Live latency, tokens, cost, and provider stability are known | Blocked                | Requires the same credentialed baseline                                                                   |
| Sanitized events and traces arrive in PostHog                | Blocked                | Local allowlists and transport code are not server-side ingestion evidence                                |
| A self-improving loop produced a beneficial result           | Blocked                | Requires a real signal, report, investigation, reviewed change, delivery, and declared post-change window |
| The product controls real connected hardware                 | Out of scope           | Gateway behavior is a deterministic simulator                                                             |
| Visual browser UX and accessibility meet release gates       | Deferred               | Visual design, browser journey review, and deployment occur after the non-visual core                     |

`Pending` means the repository has not retained evidence for the broad claim. `Blocked` means an external approval, credential, paid action, or observation window is required. Neither status is a failure of the credential-free core.

## Important simulation boundary

The deterministic corpus uses synthetic decision-contract environments. It is designed to pressure the engine and scorer with typed live-state projections, but it is not a substitute for the production database, worker, gateway, HTTP transport, MCP transport, or independent verifier. Those layers require their own receipts.

## Important analytics boundary

A local JSONL event proves that an allowlisted payload was produced. A client flush proves only that the SDK returned. Only server-side observation in an approved PostHog project can earn **PostHog-ingestion-verified**.

Likewise, deterministic pre/post fixture measurements can validate a metric implementation, but they cannot earn **Live-loop-verified**. Read [how local evidence becomes an improvement claim](../../knowledge/concepts/evidence-and-improvement.md) before interpreting a report.

## Recheck before publication

Before sharing a completion claim, rerun the report check, the repository quality gate, the publication-safety scan, the clean Ubuntu Quest, and the relevant database integration suite. Retain exact receipts rather than turning an earlier status report into current product documentation.
