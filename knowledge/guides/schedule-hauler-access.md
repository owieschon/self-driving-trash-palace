# Schedule safe hauler access

This guide creates a recurring collection window that opens only the service hatch for one assigned hauler and verifies that it relocks.

Before you begin, understand [goals and durable changes](../concepts/missions-plans-and-operations.md), [uncertain outcomes](../concepts/unknown-outcomes.md), [context and authority](../concepts/context-authority.md), and [review controls](review-approve-or-cancel.md).

## Define the outcome and limits

Use this customer outcome: “Let Neighborhood Compost Co. collect on Wednesday between 08:00 and 08:20.” Keep these as hard limits:

- only the assigned hauler identity tag is accepted;
- only the service hatch may unlock;
- the residential hatch remains locked;
- access ends at 08:20;
- the service hatch must finish locked.

## Review the exact change

Open **Automations**, select **Scheduled Hauler Access**, and compare current manual access with the proposed schedule. Approval binds to that exact diff. Reject leaves the existing automation unchanged. Cancel closes the review without recording a decision.

## Execute the same API path as other automations

The product sends the constrained request through `POST /api/v1/missions`. The reusable program registry selects the Hauler planner, simulator, execution planner, and verifier. Caretaker receives Hauler guidance and shared safety references, but not Homecoming temperature or lighting context.

## Observe the result

Success requires durable evidence that the assigned hauler arrived inside the window, only the service hatch unlocked, the residential hatch remained locked, and the service hatch finished locked. If the provider response is lost, TrashPal reports **Outcome unknown** and reconciles the original operation before any retry.

## Next step

[Inspect receipts and evidence](inspect-receipts-and-evidence.md).
