# Contributor contract

This repository separates executable product truth from explanations and run evidence.

- `packages/core` owns domain, state, role, tool, event, and policy contracts.
- `packages/observability` owns safe evidence capture and export boundaries.
- `packages/agent` owns Pal context projection and skill packaging, not domain authorization.
- `knowledge` explains product behavior and cites stable claim IDs.
- `evals` owns versioned scenarios and expected outcomes.
- `docs/decisions` owns architectural rationale; receipts own run evidence.

Never place credentials, raw customer data, private prompts, home-directory paths, or private PostHog links in repository artifacts. External publication and credentialed runs require separate approval.
