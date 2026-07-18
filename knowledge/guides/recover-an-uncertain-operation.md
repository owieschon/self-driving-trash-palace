# Recover an uncertain operation

Use this guide when TrashPal may have recorded a change but is still checking the result. Recovery follows the existing operation so a lost response cannot turn into a duplicate change.

## Before you start

Read [Unknown outcomes are not failures](../concepts/unknown-outcomes.md), then follow the normal [create, approve, and check a proposal](create-approve-and-verify-a-routine.md) path once. Recovery preserves the records created by that path.

## 1. Recognize the situation

You may see **checking the result** after an approved action when TrashPal has not received enough evidence to tell whether the action completed. This is not the same as a failed result.

Do not prepare a replacement for the same change. Find the original request in **Activity** and let TrashPal reconcile its retained state first.

## 2. Follow the original request

1. Confirm that the original request matches the change you intended.
2. Keep following that request in **Activity** while TrashPal checks its result.
3. Use the result if TrashPal verifies it.
4. Start a new bounded request only if TrashPal reports that the original request did not complete or a separate corrective action is needed.

## Why TrashPal does not create a second operation

The reference product retains a negative-control scenario named **Two Routines, One Timeout**. It shows why a blind retry is unsafe: a lost response can describe a change that already happened.

<!-- claim:TP-INCIDENT-001 -->

The quarantined legacy handler duplicates the routine because it accepts client-created operation identities, lacks organization-plus-plan-action uniqueness, and does not revalidate the protected routine version before activation. A blind retry therefore creates a second operation and a second routine.

<!-- claim:TP-INCIDENT-002 -->

The corrected service creates one server-owned operation per approved action, enforces operation and plan-action uniqueness, revalidates protected versions, commits the operation ledger with domain state, and reconciles an unknown response before retrying the same operation.

| Observation                  |       Legacy path |            Corrected path |
| ---------------------------- | ----------------: | ------------------------: |
| Logical operations           |                 2 |                         1 |
| Transport attempts           |                 2 |                         2 |
| New active routines          |                 2 |                         1 |
| Outcome after reconciliation | Duplicate failure | Original committed result |

## Developer depth

The negative control must create exactly two routines and fail the duplicate-outcome assertion. If it passes the corrected assertion, the evaluation is broken. Developers can inspect the transport and runtime contract in [Build with HTTP and MCP](build-with-http-and-mcp.md).

## Next step

[Troubleshoot the mission from durable state](troubleshoot-a-mission.md).
