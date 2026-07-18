# Read recent Activity

Use this guide when you need to know whether a recent request needs your decision, is still running, or has reached a final status. **Activity** is a concise operational history: each item shows a request summary, current status, and latest update.

Before opening Activity, [prepare and review a proposal](create-approve-and-verify-a-routine.md).

Use [review or reject a proposal](review-approve-or-cancel.md) when the next step needs a member decision. For the technical evidence behind a verified result, see [what proves a result](../concepts/evidence-and-improvement.md).

## Read Activity in this order

1. Start with the request summary. Confirm that it is the work you asked Pal to do.
2. Read the current status. It tells you whether Pal is working, needs your decision, is checking the result, or has a verified or failed result.
3. Check the latest update. It tells you when TrashPal last changed that request's status.
4. If the request needs input or approval, return to **Automations** to continue the decision.
5. If TrashPal is still checking the result, keep following the same request instead of creating another one.

| Status                     | What it means                                          | What to do next                                 |
| -------------------------- | ------------------------------------------------------ | ----------------------------------------------- |
| **working**                | Pal is preparing, running, or reconciling the request. | Wait for the next update.                       |
| **needs input**            | Pal needs one bounded answer.                          | Return to **Automations** and answer it.        |
| **needs approval**         | A proposal is ready for your decision.                 | Review or reject the proposal.                  |
| **checking the result**    | TrashPal has not verified the requested outcome yet.   | Do not create a duplicate request.              |
| **verified** or **failed** | TrashPal reached a final status for this request.      | Decide whether a new bounded request is needed. |

Activity does not expose proposal revisions, approval records, operations, delivery attempts, or evidence receipts. It stays focused on what needs attention and what you can safely do next.

## Developer depth

Developers can inspect context receipts, tool receipts, and analytics export records in [the executable API, MCP, and event reference](../resources/executable-contracts.md). Those records explain the runtime contract; they are not part of the customer-facing Activity view.

## Next step

[Recover an uncertain operation without creating another one](recover-an-uncertain-operation.md).
