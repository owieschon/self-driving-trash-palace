# Troubleshoot an automation

Use this guide to find the next safe action from the Palace workspace and **Activity** instead of guessing from a status message.

For a pending result, start with [what it means when TrashPal is still checking the result](../concepts/unknown-outcomes.md). For the proof behind a completed result, read [what proves a result](../concepts/evidence-and-improvement.md).

Start with the current status in your Palace workspace. Each status has one safe next step.

| What you see                | What it means                                        | What to do next                                                                               |
| --------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| **working**                 | Pal is preparing, running, or reconciling a request. | Wait or open **Activity** for the latest status and update time.                              |
| **needs input**             | Pal needs one bounded decision.                      | Answer the listed clarification.                                                              |
| **needs approval**          | A proposal is ready for your decision.               | Review its actions and safety rules, then approve or reject it.                               |
| **checking the result**     | TrashPal has not verified the requested outcome yet. | Keep following the same request. Do not submit it again.                                      |
| A result failed             | TrashPal did not verify the requested outcome.       | Open **Activity**, confirm the failed status, and start a new bounded request only if needed. |
| A device provider timed out | Device delivery and application state may disagree.  | Let TrashPal reconcile the original request before deciding on another one.                   |

## Recovery

If the problem followed a lost or delayed response, [recover an uncertain operation](recover-an-uncertain-operation.md). That procedure preserves the original operation so a retry cannot multiply the intended change.

## Developer help

If you are integrating TrashPal or investigating its runtime contracts, [build with HTTP and MCP](build-with-http-and-mcp.md). Developer docs are part of Help and remain directly available.

## Next step

[Understand what Pal can use and what it cannot decide](../concepts/context-authority.md).
