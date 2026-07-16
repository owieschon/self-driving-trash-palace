# ADR 0003: Freeze context and split receipts

This decision makes context selection reproducible without exposing private runtime details.

Status: Accepted

## Context

An agent run cannot be investigated if its sources or contracts silently move to `latest`. A single receipt shape would either omit operational evidence or risk publishing internal source names, paths, tenant identifiers, and trace locations.

## Decision

Freeze one context bundle per run. Pin schema, compiler, application, API, tool-registry, policy, source, and artifact versions and hashes. Reject an incompatible pin rather than falling back.

Retain two schemas. The internal receipt records selected and excluded source identities, reasons, hashes, runtime versions, redaction counts, and private trace correlation. The public receipt contains only approved citations, safe version labels, bounded rationale, a sanitized repository-relative evidence link, and redaction totals.

## Consequences

- Resume creates a new run and receipt while the mission remains durable.
- Public artifacts cannot accept extra internal fields because both schemas are strict.
- A context receipt proves assembly, not model discipline or product correctness.
