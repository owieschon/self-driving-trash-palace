# TrashPal

TrashPal is a full-stack reference SaaS for trusted automations in connected raccoon homes. Rocky the raccoon uses it to coordinate access, lighting, comfort, and energy at his Sacred Dumpster Trash Palace. Its Caretaker agent proposes changes within explicit limits; the application owns approval, durable execution, recovery, and verification.

Start with the [product overview](knowledge/index.md), then [improve your first automation](knowledge/getting-started/improve-your-first-automation.md) without credentials or paid model calls.

This is an independent fictional project. It is not an official PostHog product. The default executable path uses simulated devices; the SmartThings adapter remains unverified against live hardware.

## Verify the repository

Run the credential-free quality gate from the repository root:

```bash
pnpm install --frozen-lockfile
pnpm check
```

The repository includes a Next.js product, PostgreSQL persistence, HTTP and MCP interfaces, a bounded Caretaker harness, deterministic and model-promotion evaluations, provider connectors, PostHog-shaped evidence, and one versioned knowledge system for people and agents.

## Learn or maintain

- [Knowledge base](knowledge/index.md): product concepts and executable guides in learning order.
- [Maintainer documentation](docs/README.md): architecture decisions, security, evaluation, and operations.
- [Executable contract guide](knowledge/resources/executable-contracts.md): how to inspect API and MCP artifacts derived from typed owners.
