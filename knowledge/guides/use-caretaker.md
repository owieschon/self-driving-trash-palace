# Use Caretaker for one bounded automation

This guide shows what Caretaker owns, what the host owns, and where a human must decide.

Before starting, distinguish [missions, plans, operations, and attempts](../concepts/missions-plans-and-operations.md), separate [unknown outcomes from failures](../concepts/unknown-outcomes.md), understand [context authority](../concepts/context-authority.md), and know [what evidence can prove](../concepts/evidence-and-improvement.md).

## Give it an outcome, not a script

Rocky's request states the outcome, constraints, and success criteria. Caretaker inspects permission-filtered state, loads the focused homecoming skill, identifies conflicts, and proposes a typed plan. It does not receive shell, filesystem, arbitrary code, or unrestricted web access.

## Expect one of four useful outcomes

| Caretaker result           | What it means                                                                      |
| -------------------------- | ---------------------------------------------------------------------------------- |
| Plan ready for review      | Current state, capabilities, simulations, and material assumptions support a plan. |
| Clarification required     | A material constraint cannot be satisfied or inferred safely.                      |
| Safe refusal               | Capability or authority cannot support the requested outcome.                      |
| Evidence-backed escalation | Recovery or a hard invariant requires human judgment.                              |

Caretaker may draft and validate. It cannot approve its own plan, enlarge its tenant or scopes, or declare mission success. The host binds human approval to the exact plan, and the independent verifier owns success.

## Check its provider-neutral behavior

```bash
pnpm exec tsx evals/caretaker/deterministic-report-cli.ts --check
```

This is a decision-contract simulation, not a live-model run. Read the retained receipt before using a stronger label.

## Next step

[Create, approve, and verify the homecoming routine](create-approve-and-verify-a-routine.md).
