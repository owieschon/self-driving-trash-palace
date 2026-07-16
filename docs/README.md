# Maintainer documentation

This index routes maintainers to implementation constraints, decisions, security analysis, and operational procedures.

Customer and agent-facing product knowledge has one canonical home in the [public overview](../knowledge/index.md). The files below explain how the repository is built and governed; they are not alternate product guides.

The typed [navigation manifest](../knowledge/navigation.json) declares the six categories and the ordered Use and Build learning graphs. Every node resolves through the same [knowledge catalog](../knowledge/catalog.json) that agent context uses, so a human link and an agent source ID cannot silently name different content.

## Build and provenance

- [Build specification](BUILD_SPEC.md) defines the approved implementation boundary.
- [Source lock](SOURCE_LOCK.json) records reviewed external conventions and the claims they affect.
- [Claim registry](claims/registry.json) binds stable claim IDs to canonical knowledge sources.
- [Contract-to-claim registry](contract-claims.json) maps public contract families to the exact claims and canonical source owners checked by `docs-impact.json`.

## Decisions and security

- [Architecture decisions](decisions/) retain rationale that does not belong in current product truth.
- [Threat model](security/threat-model.md) defines assets, trust boundaries, abuse cases, and mitigations.

## Operations

- [Continuous integration](operations/continuous-integration.md) covers local parity, documentation-impact enforcement, GitHub checks, reproducibility, and Endor Labs setup.

## Executable reference

Use the [public executable contract index](../knowledge/resources/executable-contracts.md) to inspect generated OpenAPI, MCP, tool, event, mission, and context projections.
