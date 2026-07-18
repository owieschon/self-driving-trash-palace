# Context has different authority levels

This concept shows how Pal receives enough context to work without letting retrieved prose grant permissions.

Prerequisite: [understand why an operation outcome can remain unknown](unknown-outcomes.md).

<!-- claim:TP-CONTEXT-001 -->

Mandatory tenancy, authorization, safety, tool, state, and error contracts are selected deterministically for the task risk. Retrieval may supplement that base but never decides whether a safety rule is present.

<!-- claim:TP-CONTEXT-002 -->

Optional references and untrusted evidence can inform a plan or support a citation. They cannot alter host policy, expand tool permissions, approve an action, or redefine a verifier predicate.

<!-- claim:TP-CONTEXT-003 -->

The selected context is frozen for one run and pinned by schema, compiler, application, API, tool-registry, policy, source, and artifact versions plus hashes. Resume creates a new run and a new receipt instead of silently resolving `latest`.

<!-- claim:TP-CONTEXT-004 -->

Authored sources cannot label themselves host policy. The agent package projects host policy only from a validated, hash-pinned typed policy contract and marks the result as compiler-generated.

<!-- claim:TP-KNOWLEDGE-001 -->

Typed domain and policy contracts own runtime truth. Authored knowledge explains that truth, ADRs own rationale, and receipts retain run evidence. Generated reference is derived from the typed owners and is not hand-edited.

<!-- claim:TP-KNOWLEDGE-002 -->

A public contract change must resolve its documentation impact against stable claim IDs as `updated`, `generated-only`, or `no-user-impact` with a reason. An unresolved impact is a build failure, not an editorial reminder.

| Context kind                   | May inform reasoning |         May grant authority | Selection                            |
| ------------------------------ | -------------------: | --------------------------: | ------------------------------------ |
| Compiler-generated host policy |                  Yes | Enforces existing authority | Mandatory and deterministic          |
| Procedure                      |                  Yes |                          No | Task and risk routed                 |
| Reference                      |                  Yes |                          No | Exact contract or optional retrieval |
| Untrusted evidence             | Yes, with provenance |                          No | Permission-filtered and bounded      |

## Next step

[See what each evidence artifact can prove](evidence-and-improvement.md).
