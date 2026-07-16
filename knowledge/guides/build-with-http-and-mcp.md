# Build with HTTP and MCP

This guide uses one application contract through two authenticated transports without giving the model a second source of truth.

Before integrating, distinguish [mission and operation identity](../concepts/missions-plans-and-operations.md), understand [context and authority](../concepts/context-authority.md), and know how to [troubleshoot from durable state](troubleshoot-a-mission.md).

## Choose the principal, not a special implementation

- Browser HTTP uses the seeded same-site session, CSRF token, trusted Origin, and recent authentication for sensitive actions.
- MCP uses a hashed, expiring, revocable delegated token bound to one tenant and explicit scopes.
- Both call the same dispatcher, application services, schemas, permissions, operation ledger, and verifier.

The tenant comes from the authenticated principal. Never accept it from a model argument or URL payload. Keep bearer values out of model context and retained receipts.

## Exercise the projections

Run the [HTTP and MCP examples](../../examples/http-and-mcp.md), then inspect the [generated OpenAPI and MCP catalog](../resources/executable-contracts.md). Examples execute repository-owned adapters; generated reference derives from the canonical registry.

Use stable idempotency and mission headers for tool calls. A same-operation, same-payload replay returns the original outcome. Changed content under the same identity conflicts.

## Next step

[Instrument the agentic workflow](../posthog-ai/instrument-an-agentic-workflow.md).
