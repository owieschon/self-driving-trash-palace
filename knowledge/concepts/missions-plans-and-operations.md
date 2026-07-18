# From a goal to one trustworthy change

This page explains the records behind one Palace change. You do not need to memorize their technical names to use TrashPal, but they explain why you can review a proposal, recover from a lost response, and avoid duplicate changes.

Start with [setting up your Palace workspace](../getting-started/start-here.md) if you need orientation, or [setting a goal for Pal](../guides/use-caretaker.md) if you want to create an automation now. Developers running the reference product can [run TrashPal locally](../getting-started/run-locally.md).

A member gives TrashPal a desired outcome, hard limits that cannot move, and preferences that may be traded off. Pal prepares one exact change. TrashPal keeps separate records for the goal, the proposal, and the action so that a retry cannot silently create a second effect.

<!-- claim:TP-MODEL-001 -->

A **mission** is one durable objective. Pal can pause for a clarification, approval, external wait, or work boundary. The mission continues from retained product state instead of depending on a chat session or a browser tab.

<!-- claim:TP-MODEL-002 -->

A **plan revision** is one frozen proposal. Its validation, simulations, protected resource versions, and member approval all apply to that exact proposal. Changing a material constraint creates a new revision and invalidates the old approval path.

<!-- claim:TP-MODEL-003 -->

An **operation** is one logical action TrashPal creates for an approved change. Its identity survives retries. Each network or delivery try receives a new **attempt** identity, so delivery history can grow without multiplying the intended change.

<!-- claim:TP-PRODUCT-001 -->

A **Palace workspace** shows one member's tenant-scoped home state, available automations, and decision context. It reads its state from the application records, so the browser does not need to guess whether an action succeeded.

| Identity      | Answers                                   | Changes on retry?     |
| ------------- | ----------------------------------------- | --------------------- |
| Mission       | What outcome are we trying to reach?      | No                    |
| Run           | Which activation is working now?          | Yes, after each pause |
| Plan revision | What exact change was proposed?           | Only after replanning |
| Operation     | What one logical mutation was approved?   | No                    |
| Attempt       | Which transport or delivery try occurred? | Yes                   |

This separation lets you distinguish repeated work from repeated effects. For example, two delivery attempts can still be one approved operation.

## What this means when you use TrashPal

You review a proposal, not an open-ended promise. You approve one exact change, not every future change. If a response is lost, TrashPal checks the existing operation before deciding whether any retry is safe.

For the HTTP, MCP, and runtime contracts behind these records, see [Build with HTTP and MCP](../guides/build-with-http-and-mcp.md). That developer guide is available in Help, but it is not a prerequisite for operating a Palace.

## Next step

[Learn how to handle an unknown operation outcome](unknown-outcomes.md).
