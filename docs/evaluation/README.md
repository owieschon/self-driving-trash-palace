# Evaluation evidence

This index routes maintainers to the one artifact that answers each evaluation question.

| Question                                                    | Canonical artifact                                                                       |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| What is scored and why?                                     | [Methodology](methodology.md)                                                            |
| What remains outside the current proof?                     | [Limitations](limitations.md)                                                            |
| What must happen before a paid or credentialed run?         | [Live-validation runbook](live-validation.md)                                            |
| What did the deterministic decision-contract corpus return? | [Retained 12-case report](../../evals/reports/deterministic-decision-contract.json)      |
| Does the broken/corrected metric contract discriminate?     | [Retained duplicate-routine report](../../evals/reports/duplicate-routine-controls.json) |
| Why is live validation still blocked?                       | [Retained blocked receipt](../../evals/reports/live-validation-blocked.json)             |

Run evidence belongs in `evals/reports`; this directory owns evaluation procedure and interpretation. Product behavior remains owned by executable contracts and the [public knowledge path](../../knowledge/index.md).
