# Recover an uncertain operation

Use this guide when a mutation may have committed but Caretaker did not receive its result.

## Before you start

Read [Unknown outcomes are not failures](../concepts/unknown-outcomes.md), then follow the normal [create, approve, and verify](create-approve-and-verify-a-routine.md) path once. Recovery preserves the identities created by that path.

## Recognize the boundary

The application commits an activation, but its HTTP or MCP response is lost at the Caretaker tool boundary. This is not a downstream device-gateway timeout.

Do not create a replacement operation. Preserve the existing operation identity and inspect its durable state first.

## Compare the two paths

The repository retains a negative-control scenario named **Two Routines, One Timeout**.

<!-- claim:TP-INCIDENT-001 -->

The quarantined legacy handler duplicates the routine because several protections are absent together: it accepts client-created operation identities, lacks organization-plus-plan-action uniqueness, and does not revalidate the protected routine version before activation. A blind retry therefore creates a second operation and a second routine.

<!-- claim:TP-INCIDENT-002 -->

The corrected service creates one operation per approved action on the server, enforces operation and plan-action uniqueness, revalidates protected versions, commits the operation ledger with domain state, and reconciles an unknown response before retrying the same operation.

| Observation                  |       Legacy path |            Corrected path |
| ---------------------------- | ----------------: | ------------------------: |
| Logical operations           |                 2 |                         1 |
| Transport attempts           |                 2 |                         2 |
| New active routines          |                 2 |                         1 |
| Outcome after reconciliation | Duplicate failure | Original committed result |

## Verify the evaluation

The negative control must create exactly two routines and fail the duplicate-outcome assertion. If it passes the corrected assertion, the evaluation is broken.

## Next step

[Troubleshoot the mission from durable state](troubleshoot-a-mission.md).
