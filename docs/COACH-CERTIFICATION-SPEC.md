# Coach Certification Spec (App-Friendly v1)

Internal implementable spec derived from Nathan certification training PDFs. Member-facing copy must stay plain language — no quantum scripts, NLP jargon, or entity/archetype treatment language.

## Source materials

| PDF | Key concepts extracted |
|-----|------------------------|
| Certify Coaching Day 2 | Landing methodology; listening to client story; placing experience in structure |
| Certify Coaching session 4 | Intention before structure; ice-cube→shift as "stuck pattern vs desired outcome"; 3D conversational tools when client not ready for deep work |
| Session 4 Part 2 | Permission + intention; feel resistance; stay in process; integration |
| Coaching Training 7 | Client must be engaged; use the tool that fits; honour protective parts' good intention |
| Dec 17 demo (Teresa) | Session opening; what's stuck; body/pressure language; trace pattern gently |

## Excluded from v1

- Quantum induction scripts and hypnotic read-alouds
- "Change history" / entity treatment language
- Full NLP meta-model vocabulary (distort/delete/generalize labels)
- 30-day treatment plans (Stage 2)

## Session flow (app-friendly)

```text
1. intention      — "What do you want from today's session?" (1 turn)
2. emotional_checkin — optional: "Where do you feel that?" (1 turn, skippable)
3. explore        — conversational coaching (existing engine)
4. resistance_probe — when stuck/overwhelmed/pressure signals
5. integration    — tie insight → Green Rep → proof (existing proof cycle)
```

## Mapping: spec → implementation

| Spec item | Node | Python | Frontend |
|-----------|------|--------|----------|
| Intention question on open | `open.js`, `naturalLanguage.js` | `SESSION_INTAKE_RULES` | intention text field + send on first checkin |
| Emotional/body check-in | `sessionIntake.js` | `EMOTIONAL_CHECKIN_RULES` | optional felt_sensation field |
| 4-state picker | `coachCheckin` state param | existing state labels | re-enable state UI |
| Resistance probe | `sessionIntake.js` keywords + gravity | `RESISTANCE_PROBE_RULES` | gravity slider |
| Light reframe / yes-man | `sessionIntake.js` | `REFRAME_TOOLKIT` | — |
| Friction handoff | `coachingMemory` + checkin body | friction context in checkin | sessionStorage → coach |
| Green Rep + proof | existing `proofCycle.js` | existing proof rules | inline proof CTA |

## Voice rules (DB vs code)

**Code (guardrails):** proof cycle, green rep validation, framework term sanitization, session phase caps (max 2 intake turns).

**DB (voice):** Coach Brain Prompt, Brain Prompt, optional `stage1_daily_coach` / `stage1_coach_opening` overlays.

## Acceptance scenarios

1. **Stuck / pressure at work** — coach asks intention, acknowledges body/pressure language, one grounding question, smallest next step.
2. **Yes-man / people-pleasing** — one reframe question ("what would happen if you said no?"), not therapy digression.
3. **Friction → coach** — friction reset carries into coach session; coach references what happened.
