# Coach architecture: now vs after (turn-mode arbiter)

Open this file in Cursor / VS Code / GitHub preview to see the Mermaid diagrams.

**Status:** implemented in `backend/src/stage1/coach/flows/turnMode.js`, applied from `stage1CoachController` after signal merge. Session latch persisted as `openSession.session_rep_locked` when a Green Rep is saved.

---

## 1. Before (many writers)

Many boxes independently set `assign_green_rep` and append instructions, so the prompt can contradict itself.

```mermaid
flowchart TD
  U[User message] --> S1[Signals rebuilt<br/>antiRepeat / conversation / clarity]
  S1 --> T[Transition brief<br/>assign true/false + long instruction]
  T --> C[Cert directives<br/>EDGE/COST, body, insight…]
  C --> F[Other flows<br/>intake / proof / activation / structural]
  F --> M[Merge]
  M --> CTRL[Controller<br/>wipe assign OR force assign]
  CTRL --> LLM[LLM reply]
  LLM --> POST[Sanitize + anti-repeat guard<br/>optional rewrite]
  POST --> OUT[Reply + green_rep JSON]

  S1 -.->|also sets assign / directives| OUT
  T -.->|also sets assign / directives| OUT
  C -.->|sticky text stays even if assign flips| OUT
  F -.->|also blocks or forces assign| OUT
  CTRL -.->|last override| OUT

  style S1 fill:#f8d7da
  style T fill:#f8d7da
  style C fill:#f8d7da
  style F fill:#f8d7da
  style CTRL fill:#f8d7da
  style M fill:#fff3cd
```

**Problem in one line:** many writers fight over one decision; leftover instructions stay after assign flips.

---

## 2. After (one arbiter) — current design

One place decides the mode; everyone else only feeds inputs; assign and instruction always match.

```mermaid
flowchart TD
  U[User message] --> IN[Inputs only<br/>turns, body, map, intake, proof, transcript]
  IN --> ARB[One arbiter<br/>resolveCoachTurnMode]
  ARB --> MODE{Session mode}
  MODE -->|DISCOVER| D[assign = false<br/>one discovery instruction]
  MODE -->|ASSIGN| A[assign = true<br/>one assign instruction]
  MODE -->|HOLD| H[assign = false<br/>support existing rep]
  MODE -->|INTEGRATE| I[proof / progress path]
  D --> LLM[LLM reply]
  A --> LLM
  H --> LLM
  I --> LLM
  LLM --> OUT[Reply + green_rep only if ASSIGN]
  A -->|persist latch| LATCH[session_rep_locked]
  LATCH -->|next turns| ARB

  style ARB fill:#d4edda
  style MODE fill:#d4edda
  style LATCH fill:#cce5ff
```

**Fix in one line:** one arbiter sets mode + assign + one instruction; session latch stops re-assign / duplicate speech.

---

## Quick reference

| Mode | Assign? | Job |
|------|---------|-----|
| DISCOVER | no | Ask / reflect only |
| ASSIGN | yes | Name pattern + one Green Rep (mechanism ready + wants next step / turn cap) |
| HOLD | no | Support existing rep for this session |
| INTEGRATE | no | Proof / progress path |

## Key files

- `backend/src/stage1/coach/flows/turnMode.js` — arbiter
- `backend/src/controllers/stage1CoachController.js` — applies arbiter after merge
- `backend/src/stage1/coach/persistence/history.js` — sets `session_rep_locked` when Green Rep saved
