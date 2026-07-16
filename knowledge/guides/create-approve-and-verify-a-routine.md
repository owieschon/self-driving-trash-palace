# Create, approve, and verify a routine

Use this guide to move one homecoming goal from current state to a verified outcome without transferring approval or success authority to Caretaker.

## Before you start

This procedure assumes you can distinguish [missions, plans, operations, and attempts](../concepts/missions-plans-and-operations.md), can [handle an unknown operation outcome](../concepts/unknown-outcomes.md), know [which context may grant authority](../concepts/context-authority.md), and know [what each evidence artifact can prove](../concepts/evidence-and-improvement.md).

## Follow the operation

1. Load the compiler-generated host policy, exact tool contracts, and current permission-filtered state.
2. Inspect palace, crew, capability, routine, and execution evidence before proposing a change.
3. Identify material conflicts and simulate the candidate against access, timing, energy, and failure constraints.

<!-- claim:TP-PROCEDURE-001 -->

4. Ask one bounded clarification when a material constraint cannot be satisfied or inferred safely. Persist the answer and create a new immutable plan revision.

<!-- claim:TP-PROCEDURE-002 -->

5. Request approval for the canonical plan hash and protected resource versions. End the activation. Resume only after the host records a valid human approval and creates the operation for the approved action.
6. Activate the existing operation. If the result is unknown, reconcile that operation before any retry.
7. Observe external evidence until the declared deadline, then run deterministic predicates.

<!-- claim:TP-PROCEDURE-003 -->

8. Report success only when the independent verifier sets the mission terminal state. Explain failed predicates or request bounded corrective work without overwriting the evidence.

Stop at a safe pause when authority, evidence, compatibility, or budget is missing. Preserve the task ledger and receipt needed for the next run.

## Next step

[Review, approve, reject, or cancel safely](review-approve-or-cancel.md).
