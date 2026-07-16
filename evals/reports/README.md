# Retained evaluation reports

This directory stores sanitized machine-readable results that can be reproduced from repository-owned inputs.

| Report                                                                         | Meaning                                                                                          |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------ |
| [`deterministic-decision-contract.json`](deterministic-decision-contract.json) | Twelve provider-neutral cases reconciled with their manifests and scorer.                        |
| [`duplicate-routine-controls.json`](duplicate-routine-controls.json)           | Broken and corrected fixture projections reconcile with the local measurement contract.          |
| [`live-validation-blocked.json`](live-validation-blocked.json)                 | The credentialed boundary is closed; no model or PostHog request is represented by this receipt. |

Reports contain evidence, not current behavioral reference. Change manifests or scorers at their executable owner, rerun the checker, inspect the diff, and retain the new report only when it matches. Never place credentials, raw prompts, private links, customer data, or absolute home paths here.
