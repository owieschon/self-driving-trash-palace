# Troubleshoot an automation from durable state

This guide maps a visible symptom to the first authoritative record to inspect.

Before troubleshooting, understand [unknown outcomes](../concepts/unknown-outcomes.md), know [what evidence can prove](../concepts/evidence-and-improvement.md), and follow the [uncertain-operation recovery](recover-an-uncertain-operation.md) procedure.

| Symptom                              | Inspect first                                       | Continue with                                                                                  |
| ------------------------------------ | --------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Mission waits for a person           | Pending clarification or exact approval             | Answer the bounded choice, approve, reject, or let the request expire                          |
| Mission waits for the system         | Operation status, latest attempt, and outbox state  | Reconcile the same operation; do not create a replacement                                      |
| Plan cannot activate                 | Approval hash, expiry, and protected versions       | Produce a new plan revision and approval when content or protected state changed               |
| Gateway reports a timeout            | Command acknowledgement and signed callback history | Separate device delivery uncertainty from application commit uncertainty                       |
| Caretaker pauses on missing context  | Context receipt exclusions and compatibility        | Repair the source or bundle contract; never silently fall back to `latest`                     |
| Verifier fails after device evidence | Failed predicate and its evidence references        | Preserve the failed run and request bounded corrective or compensating work                    |
| Local analytics output is absent     | Evidence mode, sink path, and event allowlist       | Keep export disabled until local capture is correct; then follow the approved export procedure |

For service startup, use `pnpm local:status` and then `pnpm local:logs`. Avoid opening or printing the generated private environment file while diagnosing configuration.

The Use path ends when the operator can identify the authoritative next action without guessing from agent prose. The Build path continues to the shared transport contracts.

## Continue the Build path

[Build with HTTP and MCP](build-with-http-and-mcp.md).
