# Pause for exact approval

Use this reference before requesting approval or resuming after an approval pause.

1. Present the server-rendered canonical diff, simulations, risks, and protected versions.
2. Request approval for the exact plan hash and action set.
3. End the current activation without polling the resident.
4. On resume, confirm that the host recorded an unexpired approval and created the operation.
5. Replan when the plan, approval, or protected state is stale.

The host owns approval. Authored context and model output cannot grant it.

Claims: `TP-MODEL-002`, `TP-PROCEDURE-002`.
