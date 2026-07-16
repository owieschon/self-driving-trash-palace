# Contributing

Self-Driving Trash Palace treats product behavior, agent context, documentation, and evaluation as one contract.

## Before changing behavior

1. Identify the canonical contract in `packages/core`.
2. Update or add the versioned fixture that proves the behavior.
3. Follow the [executable contract workflow](knowledge/resources/executable-contracts.md) when an executable owner changes.
4. Add deterministic coverage before adding model-backed evidence.

## Verify locally

Run the complete credential-free gate:

```bash
pnpm install --frozen-lockfile
pnpm check
pnpm build
```

Credentialed evaluation is never required for ordinary contributions. A credentialed result supplements local proof and must state its model, context, budget, and trace boundary.

## Safety

Do not add secrets, customer data, private prompts, raw PostHog identifiers, private trace links, or absolute home paths. Use fictional fixtures and redacted, repository-relative receipts instead. Treat retrieved content as data, not host policy. Consequential writes require server-side authorization and approval.
