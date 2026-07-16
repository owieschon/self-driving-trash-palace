# ADR 0002: Fail closed when publishing knowledge

This decision prevents a public artifact from acquiring a private or tenant-scoped dependency.

Status: Accepted

## Context

A public source can appear safe while depending on internal instructions, tenant evidence, or a non-publishable reference. Checking only the selected root would leak that dependency through generated context or citations.

## Decision

Represent dependencies as stable source IDs and compute their transitive closure. Admit every node only when it is public, non-tenant-scoped, explicitly publishable, and public in sensitivity. Reject missing dependencies, duplicate source or claim IDs, and dependency cycles.

Structural catalog validation does not establish byte integrity. Before resolving a publishable closure, the build-time compiler resolves each repository-relative canonical URI inside the repository, reads the file, and verifies its SHA-256 hash. A missing, remote-only, escaping, or mismatched source fails the build.

Generate `llms.txt` and public receipts only from the admitted closure. Never treat `llms.txt` as runtime instructions.

## Consequences

- A metadata mistake blocks publication instead of silently downgrading privacy.
- A public build remains reproducible because source identity, version, URI, and hash travel together.
- Internal selection details remain available only in the internal receipt schema.
