# TrashPal language and state contract

This document defines the public product words and display states that every TrashPal surface must use.

## Product model

| Term             | Meaning                                                                                                                                   | Durable source of truth                                         |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| TrashPal         | The multi-tenant product for operating a connected home.                                                                                  | Tenant-scoped application services and web API.                 |
| Palace           | One member's connected home.                                                                                                              | `PalaceSchema`; its organization is the tenant boundary.        |
| Palace workspace | The control surface for one Palace. It shows server-derived current state, attention, automations, and Activity.                          | `PalaceWorkspaceResponseSchema`.                                |
| Member           | A person with a role in the Palace's organization.                                                                                        | Authenticated session and membership records.                   |
| Pal              | The product's bounded agent. It operates approved automations within saved preferences and limits, and prepares work that needs a person. | Existing mission host, worker, policy, and tool registry.       |
| Goal             | A desired outcome expressed as an objective, active routine, or stored member preference. It is not a new database object.                | Mission objective, routine, and preference records.             |
| Automation       | An approved recurring program that Pal can operate within its saved limits.                                                               | Routine version and its approved plan.                          |
| Safety rule      | A limit Pal must preserve, such as a verified identity requirement, restricted device, time window, or energy budget.                     | Mission constraints, plan constraints, and protected resources. |
| Proposal         | A frozen plan revision that describes requested actions, constraints, and success checks.                                                 | Plan plus pending approval task.                                |
| Approval         | A time-bounded human decision over one exact proposal revision.                                                                           | Approval record and nonce.                                      |
| Activity         | A concise record of a durable product event and its verified outcome when one exists.                                                     | Mission, operation, execution, and verification evidence.       |

Rocky is the seeded member used by fixture data. He is not a separate product mode or the audience for the product's information architecture.

Use **TrashPal** for the product, **Palace** for a member's connected home, and **Pal** for the bounded agent that works within that Palace. These are public product terms. Durable code, evaluator, and retained-evidence identifiers may still contain `Caretaker`; they are compatibility identifiers, not public labels.

## Authority model

Pal operates an existing approved automation without asking again when the event, capability, and safety rules all remain inside that automation's stored limits. Pal asks a bounded clarification when material information is missing. It requires an approval for a new automation, a broader permission, a weaker safety rule, or a materially changed proposal.

A proposal is not an automation. An approval is not execution. A recorded operation is not a verified outcome.

## Display states

The browser renders these states from durable records. It does not maintain a second lifecycle or infer a successful result from a request, approval, or operation alone.

| Display state | Existing truth it represents | Customer meaning | Allowed next action |
| --- | --- | --- |
| `working` | Queued or running mission with no pending human task. | Pal is preparing, running, or reconciling the request. | Wait or view Activity. |
| `needs_input` | Pending clarification for the mission. | Pal needs one bounded decision before it can continue. | Answer the listed clarification choice. |
| `needs_approval` | Pending approval tied to one plan revision and nonce. | Review the exact proposal before Pal can act. | Approve or reject that proposal. |
| `applying` | The approval decision mutation is in flight. | TrashPal is recording the member's decision once. | Wait. |
| `checking_result` | An approved operation is pending, unknown, committed but not yet verified, or awaiting observation. | Pal is still checking what happened. | View Activity; wait for evidence. |
| `verified` | Verification evidence records that the mission's required assertions passed. | The requested outcome was verified. | View Activity. |
| `failed` | Durable mission, operation, execution, or verification evidence reports terminal failure. | The requested outcome was not achieved. | View Activity or start a new request when supported. |
| `cancelled` | Durable mission cancellation or explicit stop has completed. | TrashPal stopped the remaining work. | View Activity or start a new request when supported. |

`unknown` is a transport condition, not a success or failure state. It maps to `checking_result` after the product preserves the original logical operation and reconciles it. The product must never create a second operation merely because a response was lost.

## Presentation-time contract

Palace greetings and presentation timestamps come from the server observation instant and the Palace's IANA timezone. The server uses the security/wall clock for this presentation context, not the accelerated fixture domain clock used by automation tests. The public day periods are `morning`, `afternoon`, and `evening`; their exact boundary rules live with the server presentation-time service.

## Language constraints

- Use **Pal**, never a generic chatbot, for the bounded product agent.
- Use **Palace** for a member's connected home and **Palace workspace** for its control surface.
- Do not rename durable `Caretaker` identifiers, evaluator paths, or retained evidence as part of a public-language change. A versioned migration must own that work.
- Say **prepare proposal**, **approve proposal**, and **checking the result** when those are the current truths.
- Do not say an automation is active, a result is verified, or a change was applied unless durable source records support that statement.
- Developer documentation is a Help destination, not a separate gated knowledge system. Audience metadata changes ordering and labels, never public access.
