# Prepare, approve, and check a proposal

Use this guide to move one Palace goal from a proposal to an evidence-backed result. It keeps the member's decision separate from the work Pal performs afterward.

Before you start, [set a goal for Pal](use-caretaker.md).

For the records behind this flow, see [how a goal becomes an automation](../concepts/missions-plans-and-operations.md). For Pal's authority boundary, see [what Pal can use and what it cannot decide](../concepts/context-authority.md). If a result is still pending, use [what it means when TrashPal is still checking the result](../concepts/unknown-outcomes.md) and [what proves a result](../concepts/evidence-and-improvement.md).

## 1. Prepare the proposal

Choose a supported automation and give Pal the outcome and safety rules that matter. Pal checks the current Palace state and prepares an exact proposal. If a material detail is missing, TrashPal shows **needs input** and waits for your answer instead of guessing.

<!-- claim:TP-PROCEDURE-001 -->

Each material change creates a new proposal revision. An answer can inform the next revision, but it does not alter a proposal that is already awaiting approval.

## 2. Approve or reject the exact change

When the Palace workspace shows **needs approval**, review the proposal's actions, protected resources, safety rules, and success checks. Confirm that it changes the intended automation without creating a duplicate one.

<!-- claim:TP-PROCEDURE-002 -->

Approve only the proposal you reviewed. TrashPal binds the decision to that exact proposal revision and records one logical operation for the approved action. Rejecting a proposal leaves the existing automation unchanged.

## 3. Check the result honestly

After approval, the workspace can show **checking the result** while TrashPal waits for provider evidence or reconciles an uncertain response. Keep following the same request. Do not create a replacement just because a response was lost.

<!-- claim:TP-PROCEDURE-003 -->

The result is verified only after retained evidence satisfies the required checks.

If a check fails, **Activity** shows a failed status so you can decide whether to make a new bounded request.

## Recovery

If an operation has already started or its outcome is uncertain, [recover the uncertain operation](recover-an-uncertain-operation.md) instead of trying the same change again.

## Next step

[Review or reject a proposal](review-approve-or-cancel.md).
