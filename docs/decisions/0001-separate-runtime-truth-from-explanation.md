# ADR 0001: Separate runtime truth from explanation

This decision assigns one canonical owner to each kind of product truth.

Status: Accepted

## Context

Pal needs compact instructions, developers need executable contracts, and maintainers need durable evidence. Copying the same behavior into policy prose, agent references, docs, and receipts would let those surfaces drift.

## Decision

Typed domain and policy contracts own runtime behavior. Tool and API registries own transport behavior. Authored knowledge owns explanation through stable claim IDs. ADRs own rationale. Receipts own run evidence. Generated references project typed owners and are not hand-edited.

Authored sources cannot declare `host_policy`. The agent package creates that section only from a validated typed policy contract whose canonical hash matches the expected pin.

## Consequences

- Runtime changes require a documentation-impact decision.
- Explanations can differ by audience while citing the same claim and invariant IDs.
- Receipts cannot become current reference merely because they record a successful run.
