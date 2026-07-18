# Set a goal for Pal

Use this guide to give Pal a supported outcome and the safety rules it must preserve while preparing a proposal. Pal is not a general-purpose chatbot: it works from the Palace state, available automation controls, and the limits you set.

Before you start, [get oriented in your Palace workspace](../getting-started/start-here.md).

For the deeper model, see [how a goal becomes an automation](../concepts/missions-plans-and-operations.md), [what Pal can use and what it cannot decide](../concepts/context-authority.md), [what proves a result](../concepts/evidence-and-improvement.md), and [what it means when TrashPal is still checking the result](../concepts/unknown-outcomes.md).

## 1. Choose a supported outcome

Open **Automations** and choose the supported outcome that best matches the work you want done. Start with the result you want, not a list of device commands.

If the available automation controls do not support your request, Pal cannot turn it into an executable proposal. Choose an available outcome or adjust the request within its visible controls.

## 2. State the limits that cannot move

Add the safety rules that must stay true, such as a verified member requirement, a restricted device, a time window, or an energy limit. Preferences can shape a proposal. They do not give Pal permission to weaken a safety rule.

For example, a member can ask for a home that is ready after a verified arrival while keeping the saved energy limit. Pal can inspect the permitted Palace state and prepare a proposal.

## 3. Prepare a proposal

Choose **Prepare proposal**. Pal may begin working, ask one bounded question, or return an exact proposal for review. It cannot approve its own proposal, broaden its access, or mark a result verified.

## Expect one of four useful states

| Palace workspace state  | What it means                                                               | What you do next                                                      |
| ----------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| **working**             | Pal is preparing, running, or reconciling the request.                      | Wait or open **Activity**.                                            |
| **needs input**         | Pal needs one bounded decision before it can continue.                      | Answer the listed clarification.                                      |
| **needs approval**      | Pal prepared an exact proposal that would change an automation or boundary. | Review the proposal.                                                  |
| **checking the result** | TrashPal has not verified the requested outcome yet.                        | Open **Activity** to check its status, then wait for the next update. |

Pal can inspect, propose, clarify, and reconcile. Approval stays with a member. The application and retained evidence determine whether a result is verified.

## Recovery

If the workspace stays on **checking the result** after a network problem, do not submit a duplicate request. Follow [recover an uncertain operation](recover-an-uncertain-operation.md) to reconcile the existing request.

## Next step

[Prepare, approve, and check a proposal](create-approve-and-verify-a-routine.md).
