# Evidence distinguishes observation from proof

This concept explains what context receipts, traces, product events, and improvement reports can each establish.

Prerequisite: [separate retrieved context from host authority](context-authority.md).

<!-- claim:TP-EVIDENCE-001 -->

An internal context receipt may retain selected and excluded source IDs, hashes, exclusion reasons, runtime versions, redaction counts, and private trace correlation. A public receipt is a different schema containing only approved citations, safe version labels, selection rationale, a sanitized repository-relative evidence link, and redaction totals.

<!-- claim:TP-EVIDENCE-002 -->

A context receipt proves which validated inputs were assembled for a run. It does not prove that a model followed them, chose good tools, or produced a correct product outcome. Those claims require live-model evidence and deterministic product verification.

<!-- claim:TP-EVIDENCE-003 -->

A self-improving loop requires a signal, report, investigation, reviewed change, delivery, and measured result. A fixture comparison or an ingested trace can support that work but cannot be relabeled as a completed live loop.

<!-- claim:TP-EVIDENCE-004 -->

Product events record meaningful state changes. AI generations and spans explain model and agent execution. Correlation links the two views, while durable product state and deterministic verifier predicates remain the authority for success.

| Artifact           | Establishes                                | Does not establish                        |
| ------------------ | ------------------------------------------ | ----------------------------------------- |
| Context receipt    | Inputs and versions selected               | Model discipline or product correctness   |
| AI trace           | Model calls, tool spans, latency, and cost | Correct durable outcome by itself         |
| Product event      | A declared product state transition        | Causal improvement by itself              |
| Verifier receipt   | Whether deterministic predicates passed    | Live-model quality across cases           |
| Improvement report | A scoped signal and investigation          | Improvement until post-change observation |

## Next step

[Use Pal for one bounded automation](../guides/use-caretaker.md).
