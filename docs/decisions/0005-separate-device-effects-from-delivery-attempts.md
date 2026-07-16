# ADR 0005: Separate device effects from delivery attempts

This decision gives each intended device change one durable identity across queue delivery and gateway retries.

Status: Accepted

## Context

A queue may redeliver after a worker crash, and a gateway response may disappear after the device accepted a command. If every delivery creates a new command, ordinary recovery can repeat an unlock, lighting change, or thermostat update.

The command also cannot contain an attempt ID. A safe retry would otherwise change the signed body or falsely reuse the first transport attempt.

## Decision

Store one logical gateway command for each operation and logical key. Derive its ID from those stable inputs, retain its payload hash across retries, and enforce uniqueness in PostgreSQL. A transport attempt references the command and a monotonically increasing dispatch generation.

Queue jobs carry organization, operation, command, and generation references. Before any gateway call, the worker reloads the command, cancellation state, and persisted causal evidence. A duplicate delivery for the same generation performs no second call. Only the gateway-effect reconciler may authorize another generation, and it sends the same logical command ID.

Keep dispatch state separate from effect state. Dispatch state records what the transport knows. Verified callbacks alone advance effect state, and a terminal effect state cannot change.

Keep effect time separate from callback delivery time. A callback's `occurredAt` and device evidence describe when the gateway observed the effect. Its signature timestamp describes when that immutable callback was sent. A delayed-callback fault delays delivery without pretending the device changed later.

## Consequences

- At-least-once queue delivery does not imply repeated device effects.
- A lost response remains unknown until callback evidence or reconciliation resolves it.
- Callback latency can be measured without corrupting the device-effect timeline.
- The gateway must treat an exact command replay as idempotent and reject the same ID with different content.
- Tests must cross the publish, gateway-call, callback, and worker-restart boundaries rather than stop at queue deduplication.
