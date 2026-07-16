# Inspect receipts and durable evidence

This guide helps you decide what happened, why Caretaker acted, and which claims are still unproven.

Before opening a receipt, understand [what each evidence artifact can establish](../concepts/evidence-and-improvement.md) and complete the [review and control](review-approve-or-cancel.md) step.

## Read from authority outward

1. Start with mission state and the verifier receipt. They determine whether the mission is terminal and which criteria passed.
2. Inspect the operation ledger. One logical operation should survive all retries.
3. Inspect attempts and gateway receipts. Multiple attempts can describe one operation without multiplying its effect.
4. Inspect the plan and approval binding. Their hashes, action IDs, protected versions, and expiry must agree.
5. Inspect the context receipt. It shows selected versions and sources, not whether a model obeyed them.
6. Use the local evidence trace to correlate safe product events and agent spans with the durable records.

| Receipt                        | Question it answers                                                 |
| ------------------------------ | ------------------------------------------------------------------- |
| Public context receipt         | Which publishable sources and safe versions were selected?          |
| Internal context receipt       | What exact inputs, exclusions, hashes, and private correlation ran? |
| Tool receipt                   | Which typed request and result crossed the broker?                  |
| Operation and attempt receipts | Did the intended mutation commit, and what delivery history grew?   |
| Verifier receipt               | Which deterministic outcome predicates passed or failed?            |
| Analytics export receipt       | Was an allowlisted event submitted, rejected, or delivery-unknown?  |

Do not expose private URIs, prompts, tenant identifiers, raw tokens, or home paths when sharing evidence. A submitted analytics batch is not PostHog ingestion proof.

## Next step

[Recover an uncertain operation without creating another one](recover-an-uncertain-operation.md).
