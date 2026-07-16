# Reconcile an uncertain change

Use this reference when activation returns pending or unknown, or loses its response.

1. Preserve the existing logical operation identity and record the failed delivery attempt.
2. Read the operation and durable resource state.
3. Return the original result when the commit exists.
4. Retry the same operation only when it is definitely absent and the host budget remains.
5. Pause with evidence when the reconciliation budget expires.

Never create a second operation to make transport uncertainty disappear.

Claims: `TP-RELIABILITY-001`, `TP-RELIABILITY-002`, `TP-INCIDENT-002`.
