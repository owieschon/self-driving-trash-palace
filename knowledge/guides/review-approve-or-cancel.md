# Review, approve, reject, or cancel safely

This guide helps a human retain authority over one consequential Caretaker plan.

Before reviewing, distinguish [mission and plan identity](../concepts/missions-plans-and-operations.md), understand [why context cannot grant authority](../concepts/context-authority.md), and follow the normal [create, approve, and verify](create-approve-and-verify-a-routine.md) path.

## Answer only the material clarification

The homecoming fixture cannot keep both Rocky's stored comfort preference and the 15-point energy bound. Choose Energy first to keep the bound, or Comfort first to revise it explicitly. Either answer creates a new immutable plan revision; it does not patch an already approved plan.

## Inspect the approval object

Approve only after checking:

1. The objective and explicit constraints match the intended outcome.
2. The diff replaces the overlapping routine rather than adding a second active routine.
3. Simulations cover access, timing, energy, and transport failure.
4. Protected routine versions are current.
5. The approval names the exact canonical plan hash and expires at a visible time.

Approval creates the server-owned logical operation for the approved action. Caretaker receives permission to activate that operation, not general permission to mutate routines.

## Reject when the plan is wrong

Rejecting ends that approval path without a durable routine mutation. Revise the request or constraints, then inspect a new plan revision and approval. Never reuse the rejected approval for changed content.

## Cancel according to the checkpoint

Cancellation before mutation can cancel pending work. After an operation is claimed or a device effect may have occurred, the system preserves terminal evidence, reconciles uncertainty, and keeps a mandatory relock when safety requires it. Recovery may require a separately validated and approved compensating plan; cancellation never rewrites history.

## Next step

[Apply the same controls to Scheduled Hauler Access](schedule-hauler-access.md).
