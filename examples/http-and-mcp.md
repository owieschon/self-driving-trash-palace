# Exercise the HTTP and MCP projections

This example runs the same typed tool registry through its in-process HTTP and Streamable HTTP MCP adapters.

Run the parity suite:

```bash
pnpm exec vitest run apps/web/src/server/transport-parity.test.ts
```

Run the delegated-token MCP lifecycle:

```bash
pnpm exec vitest run apps/web/src/server/delegated-mcp-lifecycle.integration.test.ts
```

The first command checks contract parity without a network listener. The second starts the managed test runtime and proves issuance, scoped MCP use, revocation, and tenant denial across the real MCP SDK transport. Neither command proves the Docker Compose topology or a browser session.

For live local MCP smoke after the composed Quest exists, use the bundled client rather than reimplementing the protocol:

```bash
TRASH_PALACE_MCP_URL="$TRASH_PALACE_ORIGIN/api/mcp" \
TRASH_PALACE_MCP_TOKEN='<EPHEMERAL_DELEGATED_TOKEN>' \
TRASH_PALACE_MISSION_ID='<MISSION_ID>' \
pnpm --filter @trash-palace/mcp smoke
```

Set `TRASH_PALACE_ORIGIN` to the loopback origin reported by `pnpm local:status`. Supply a token issued by the local application and revoke it after the example. Do not place the value in shell history, screenshots, or retained receipts.
