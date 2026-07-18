# Retained evaluation reports

This directory stores sanitized machine-readable results that can be reproduced from repository-owned inputs.

| Report                                                                         | Meaning                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [`deterministic-decision-contract.json`](deterministic-decision-contract.json) | Twelve provider-neutral cases reconciled with their manifests and scorer.                        |
| [`duplicate-routine-controls.json`](duplicate-routine-controls.json)           | Broken and corrected fixture projections reconcile with the local measurement contract.          |
| [`claude-live-smoke-attempt1.json`](claude-live-smoke-attempt1.json)           | The first bounded Claude adapter request failed closed without a retained usage receipt.         |
| [`claude-live-smoke.json`](claude-live-smoke.json)                             | One bounded credentialed Claude decision selected the request-allowed discovery tool.            |
| [`live-validation-blocked.json`](live-validation-blocked.json)                 | The pre-authorization snapshot made no model or PostHog request.                                 |
| [`posthog-ingestion-live.json`](posthog-ingestion-live.json)                   | One sanitized product event and one AI span/trace pair were observed in the approved US project. |
| [`posthog-product-path-live.json`](posthog-product-path-live.json)             | All 76 allowlisted events from one composed TrashPal mission were observed server-side.          |

Reports contain evidence, not current behavioral reference. Change manifests or scorers at their executable owner, rerun the checker, inspect the diff, and retain the new report only when it matches. Never place credentials, raw prompts, private links, customer data, or absolute home paths here.
