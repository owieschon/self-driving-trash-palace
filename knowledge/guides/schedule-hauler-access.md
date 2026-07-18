# Schedule safe hauler access

Use this guide to prepare a recurring collection window that opens only the service hatch for one assigned hauler and checks that it relocks. It is a concrete example of how Pal works inside an approved automation's saved limits.

Before you begin, [get oriented in your Palace workspace](../getting-started/start-here.md).

This example follows [how a goal becomes an automation](../concepts/missions-plans-and-operations.md), [the proposal review boundary](review-approve-or-cancel.md), and [what Pal can use and what it cannot decide](../concepts/context-authority.md). If TrashPal is still checking the result, read [what that status means](../concepts/unknown-outcomes.md) before creating another request.

## 1. Define the outcome and limits

Use this outcome: “Let Neighborhood Compost Co. collect on Wednesday between 08:00 and 08:20.” Keep these as hard limits:

- only the assigned hauler identity tag is accepted;
- only the service hatch may unlock;
- the residential hatch remains locked;
- access ends at 08:20;
- the service hatch must finish locked.

## 2. Prepare and review the exact change

Open **Automations**, select **Scheduled Hauler Access**, and ask Pal to prepare a proposal. Compare the current manual access with the proposed schedule. Approval binds to that exact change. Rejecting a proposal leaves the existing automation unchanged. Cancelling closes the review without recording a decision.

## 3. Check the result

Open **Activity** after approval to see the request's current status and latest update.

A verified result means TrashPal received durable evidence that the assigned hauler arrived inside the window, only the service hatch unlocked, the residential hatch remained locked, and the service hatch finished locked.

If TrashPal is still checking the result after a lost provider response, follow the existing request. Do not prepare a second change for the same collection window.

## Developer depth

The HTTP, MCP, and program-routing details behind this automation live in [Build with HTTP and MCP](build-with-http-and-mcp.md). That reference is available to anyone, but it is not required to schedule hauler access.

## Next step

[Read recent Activity](inspect-receipts-and-evidence.md).
