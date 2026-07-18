# Instrument an agentic workflow

This guide connects agent execution to product outcomes without treating an AI trace as proof of success.

Before instrumenting, understand [evidence and improvement](../concepts/evidence-and-improvement.md) and exercise the shared [HTTP and MCP contracts](../guides/build-with-http-and-mcp.md).

## Start with the local evidence sink

Capture meaningful state transitions at their authoritative service boundary. Use the typed event registry and one stable event ID so retries reuse the same PostHog `$insert_id`. Keep incidental interface clicks out of the custom event vocabulary.

Use pseudonymous mission, run, operation, attempt, user, and organization aliases. Never export raw database IDs, prompts, credentials, headers, customer data, or private links.

## Separate product events from AI traces

| Evidence                    | Use it for                                                           |
| --------------------------- | -------------------------------------------------------------------- |
| Product event               | A meaningful state transition such as plan approval or verification  |
| AI generation               | One model request with safe model, token, latency, and cost metadata |
| AI span                     | Context assembly, retrieval, tool use, simulation, or reconciliation |
| Durable record and verifier | Authority for the product outcome                                    |

Pin model, context bundle, tool registry, app, and feature-flag versions for the mission. Correlate the agent trace with durable product evidence, but keep the verifier independent of analytics delivery.

## Measure one failure class

The first report counts plans with duplicate durable routines per 1,000 activation intents. Guard it with verifier pass rate, activation and reconciliation latency, cancellation safety, human intervention, and model cost. Use the deterministic broken and corrected fixtures to validate the query; wait for a real observation window before claiming improvement.

The local sink remains the evidence owner until an approved export is configured.

## Next step

[Validate the improvement metric](validate-an-improvement-metric.md).
