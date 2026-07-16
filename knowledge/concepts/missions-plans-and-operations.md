# From a resident goal to one durable change

This concept starts with customer language, then maps it to the internal identities that make a consequential agent run inspectable and safe to resume.

Prerequisite: [improve your first automation](../getting-started/improve-your-first-automation.md).

A resident gives TrashPal a desired outcome, hard limits that cannot move, and preferences that may be traded off. Caretaker proposes one exact change. Internally, TrashPal represents that journey with the following durable identities.

<!-- claim:TP-MODEL-001 -->

A **mission** is one durable objective. A model activation may end at a clarification, approval, external wait, or lease boundary, but the mission continues from persisted state rather than assumed conversational memory.

<!-- claim:TP-MODEL-002 -->

A **plan revision** is one immutable proposal. Validation, simulations, protected resource versions, and the human approval bind to its canonical hash. Changing a material constraint creates a new revision and invalidates the old approval path.

<!-- claim:TP-MODEL-003 -->

An **operation** is one logical mutation created by the host for an approved action. Its identity survives retries. Each network or delivery try receives a new **attempt** identity, so transport history can grow without multiplying the intended change.

| Identity      | Answers                                   | Changes on retry?     |
| ------------- | ----------------------------------------- | --------------------- |
| Mission       | What outcome are we trying to reach?      | No                    |
| Run           | Which activation is working now?          | Yes, after each pause |
| Plan revision | What exact change was proposed?           | Only after replanning |
| Operation     | What one logical mutation was approved?   | No                    |
| Attempt       | Which transport or delivery try occurred? | Yes                   |

This separation lets a reviewer distinguish repeated work from repeated effects.

## Next step

[Learn how to handle an unknown operation outcome](unknown-outcomes.md).
