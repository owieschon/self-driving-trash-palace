# ADR 0004: Route one focused skill per automation program

This decision keeps Caretaker context small enough to inspect and evaluate as TrashPal adds reusable programs.

Status: Accepted

## Context

TrashPal began with Night Shift Homecoming and now supports Scheduled Hauler Access through the same program seam. A universal prompt or undifferentiated RAG corpus would expose each program to irrelevant rules and make authority harder to audit. Duplicating approval and recovery instructions would let shared safety behavior drift.

## Decision

Route one focused skill for each program. Homecoming receives only resident-arrival, comfort, lighting, and energy guidance. Hauler Access receives only assigned-identity, collection-window, hatch-scope, and final-lock guidance. Both receive the same host-selected approval, reconciliation, verification, tool, policy, and tenant contracts.

The context router proves each program excludes the other program's authored sources. Authored sources remain guidance and cannot grant host authority.

## Consequences

- Program cases can test both inclusion and exclusion, not only retrieval relevance.
- Shared safety behavior has one canonical source.
- Adding a skill requires a product program and executable case that the existing programs cannot solve.
- A universal RAG chatbot and autonomous writer remain outside this product boundary.
