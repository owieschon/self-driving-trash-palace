# TrashPal

This overview explains what TrashPal does, who it is for, and where to begin.

Rocky runs a fictional SaaS business for raccoon households with connected dumpster homes. Residents want recurring jobs handled without giving an AI unlimited control: prepare a home after a verified arrival, let an assigned hauler use only the service hatch, preserve the morning energy reserve, and prove the home returned to a safe state.

TrashPal turns those recurring outcomes into reviewable automations. Caretaker can inspect current state and propose a change. The host application decides what context and tools are available, binds approval to the exact proposal, executes one durable operation, preserves uncertain outcomes, and accepts completion only from deterministic verification.

```text
desired outcome + hard limits + preferences
                    |
                    v
context -> proposed change -> approval -> operation -> evidence -> verification
   ^                                                               |
   +---------------- reviewed improvement signal -------------------+
```

The repository implements the full stack behind that experience: durable domain state, application services, HTTP and MCP projections, an agent harness, executable contracts, provider boundaries, analytics-safe PostHog evidence, and a versioned knowledge system shared by people and agents.

## Follow the learning order

1. **Overview**: understand the product and proof boundaries.
2. **Getting started**: run the local system and improve one automation.
3. **Concepts**: learn goals and limits, approvals, uncertainty, context, and evidence.
4. **Guides**: operate Homecoming and Hauler Access, then inspect or troubleshoot results.
5. **PostHog AI**: connect product outcomes to agent traces and a scoped improvement study.
6. **Resources**: inspect evaluation limits and generated contracts.

## Next step

[Choose the shortest learning path](getting-started/start-here.md).
