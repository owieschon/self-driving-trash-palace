# Set up your Palace workspace

Use this guide to get oriented in a Palace workspace and prepare a first proposal with Pal. By the end, you will know where to choose a goal, where to make a decision, and where to check what happened.

If you have not read it yet, start with [what TrashPal does](../README.md).

You do not need to install or configure anything to understand the product flow. The local setup guide is for developers who are running the reference product from a checkout.

## 1. Get oriented

Open the Palace workspace for the connected home you manage. It shows the current home state, automations, items that need attention, and **Activity**. Use these areas for different jobs:

| Area        | Use it when you want to                                                     |
| ----------- | --------------------------------------------------------------------------- |
| Home        | See the current Palace state and the next item that needs attention.        |
| Automations | Choose or review a supported recurring outcome.                             |
| Activity    | See recent requests, their current status, and when they were last updated. |

Treat a sample-data label as a reminder that this reference product uses simulated devices.

## 2. Choose a useful first goal

Open **Automations** and choose a supported automation idea, such as **Scheduled Hauler Access**. Start with the outcome you want, then add the limits Pal must preserve. For hauler access, the proposal should keep these limits visible:

- only the assigned hauler tag can use the service hatch;
- the residential hatch stays locked; and
- the service hatch returns to locked when the visit ends.

Ask Pal to **prepare a proposal**. Pal may begin working, ask one bounded question, or return an exact proposal for review. A proposal is not an automation yet.

## 3. Review before Pal acts

When the workspace shows **needs approval**, read the proposed actions, safety rules, and success checks. Choose **Approve proposal** only if they match what you want. Rejecting the proposal keeps the existing automation unchanged.

After approval, TrashPal may show **checking the result**. That means it has recorded the decision and is waiting for durable evidence. It does not mean the outcome is verified yet.

## 4. Check Activity when you need an answer

Open **Activity** to see each recent request's summary, current status, and latest update. If a response was lost, do not start the same change again. Keep following the original request while TrashPal reconciles it.

## What success looks like

You can identify your Palace, describe the goal you gave Pal, review a proposal, and tell whether a request needs a decision, is still checking, or is verified.

For the model behind that sequence, see [how a goal becomes an automation](../concepts/missions-plans-and-operations.md).

If you are developing or integrating with TrashPal, [run TrashPal locally](run-locally.md). That setup is developer documentation, not a requirement for operating a Palace.

## Next step

[Set a goal for Pal](../guides/use-caretaker.md).
