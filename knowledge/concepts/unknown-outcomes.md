# Unknown outcomes are not failures

This concept explains how to recover when a mutation may have committed but its response is lost.

Prerequisite: [distinguish operations from attempts](missions-plans-and-operations.md).

<!-- claim:TP-RELIABILITY-001 -->

A timeout after a write means the outcome is **unknown**. It does not prove failure, and treating it as failure can turn a harmless transport fault into a duplicate durable effect.

<!-- claim:TP-RELIABILITY-002 -->

Recover by preserving the same operation identity and reconciling durable state. Return the original outcome when the commit exists. Retry the same operation only when it is definitely absent and the retry budget remains. Pause with evidence when neither conclusion is safe.

```text
write response lost
        |
        v
query the existing operation
   | committed       | definitely absent       | still uncertain
   v                 v                         v
return outcome       retry same operation      pause with evidence
```

Never create a fresh logical operation merely because an attempt timed out. A new attempt may be correct; a new operation changes the meaning of the approved work.

## Next step

[Learn how context and authority remain separate](context-authority.md).
