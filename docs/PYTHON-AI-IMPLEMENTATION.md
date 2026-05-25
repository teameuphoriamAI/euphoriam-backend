# Python / AI Service — Implementation Plan

**Purpose:** Everything that uses LLMs, conversational QA, chat orchestration, prompts, RAG, and structured AI extraction — **to be built or migrated in Python** (separate from Node.js API layer).

**Companion doc:** [NODEJS-IMPLEMENTATION.md](./NODEJS-IMPLEMENTATION.md) — auth, DB, REST, PDF, email, storage.  
**Product spec:** [EUPHORIAM-STAGE1-STAGE2-README.md](./EUPHORIAM-STAGE1-STAGE2-README.md)

---

## Table of contents

1. [Architecture split](#architecture-split)
2. [What exists today in Node (migrate to Python)](#what-exists-today-in-node-migrate-to-python)
3. [New requirements (Stage 1 / V2) — AI only](#new-requirements-stage-1--v2--ai-only)
4. [Prompt inventory](#prompt-inventory)
5. [Flows to implement in Python](#flows-to-implement-in-python)
6. [API contract (Node ↔ Python)](#api-contract-node--python)
7. [Python project structure (suggested)](#python-project-structure-suggested)
8. [Phased build plan](#phased-build-plan)
9. [Models, schemas & writeback](#models-schemas--writeback)
10. [Testing](#testing)
11. [Do not move to Python](#do-not-move-to-python)

---

## Architecture split

```text
┌─────────────┐     REST / internal HTTP      ┌──────────────────────┐
│  Frontend   │ ────────────────────────────► │  Node.js (euphoriam-  │
│             │     JWT, stage1 CRUD, etc.    │  backend)            │
└──────┬──────┘                               └──────────┬───────────┘
       │                                                  │
       │ WebSocket (chat) ────────────────┐               │ POST /ai/*
       │                                  ▼               ▼
       │                          ┌───────────────────────────────┐
       └────────────────────────► │  Python AI service            │
                                  │  - QA / diagnostic intake     │
                                  │  - Discovery & coach chat     │
                                  │  - Reports & extraction       │
                                  │  - RAG, prompts, guardrails   │
                                  └───────────┬───────────────────┘
                                              │
                                  ┌───────────▼───────────┐
                                  │ OpenAI / embeddings     │
                                  │ Postgres (read prompts) │
                                  │ Chroma / vector DB      │
                                  └─────────────────────────┘
```

**Rule:** Node owns **persistence contracts** (save transcript, diagnostic row, `metadata.stage1`). Python owns **generation** (next question, report text, extraction JSON, coach reply).

---

## What exists today in Node (migrate to Python)

| Capability | Current Node location | Migrate priority |
|------------|---------------------|------------------|
| Paid diagnostic Q&A (~25Q + CB1–6) | `diagnosticController.js`, `euphoriamChatbot.js` | **P0** |
| Socket chat turn (user message → assistant) | `chatbotFreeformSocket.js` | **P0** |
| Discovery mode chat + report | `handleDiscoveryMode`, `handleDiscoveryFinalize` | **P1** |
| Brain + Diagnostic prompt assembly | `euphoriamChatbot.js`, `getLatestPromptFromDb` | **P0** |
| Final diagnostic report generation | `buildFinalReportPrompt`, OpenAI in controller/socket | **P0** |
| Discovery follow-up report | `diagnosticController.js` (discovery sections) | **P1** |
| Confidence score + clarifier (CB) questions | `calculateDiagnosticConfidence`, CB generation | **P0** |
| Intent detection (end chat, generate report) | `validation.js` — `detectDiscoveryEndIntents`, etc. | **P1** |
| Gibberish / social / injection guard | `validation.js`, `promptInjectionGuard.js` | **P1** |
| RAG retrieval | `helpers/rag.js`, `chromadb.js`, `vectorStoreService.js` | **P2** |
| Structured packet extraction (funnel Stage 1) | `structuredPacketExtractor.js` | **P1** — pattern for goal extraction |
| IRL report (Stage 2 funnel) | `irlReportGenerator.js` | **P2** — can stay Node initially or move |
| IRL / constraint extraction prompt | `stage1_constraint_extraction` | **P2** |
| Session summary for discovery | `config/sessionSummary.js` | **P2** |
| Voice → text (if LLM post-process) | `voiceController.js` | **P3** |
| Admin prompt CRUD content | Stays in DB; **Python reads** active prompts | — |
| Market research aggregation LLM | `marketResearchAggregator.js` | **P3** |
| Metrics extraction from report (regex/LLM) | `diagnosticController`, `metricsCalculator.js` | **P1** |

### Large files to decompose when migrating

| File | ~Role in Python |
|------|-----------------|
| `src/helpers/euphoriamChatbot.js` | `services/chat/prompt_builder.py`, `services/chat/intake.py` |
| `src/controllers/diagnosticController.js` | Split: Node HTTP shell + Python `services/diagnostic/` |
| `src/socket/chatbotFreeformSocket.js` | Python FastAPI WebSockets **or** Node proxy calling Python per message |
| `src/utils/validation.js` | `services/guardrails/intent.py`, `injection.py` |

---

## New requirements (Stage 1 / V2) — AI only

These are from the client spec + Nathan Brain V2 email. **Node stores results; Python produces them.**

### A. Goal onboarding (light AI — optional Phase 1)

| Task | Python responsibility |
|------|----------------------|
| Suggest milestones from outcome | `POST /ai/onboarding/suggest-milestones` — input: `ACTIVE_GOAL_CONTEXT` partial |
| Sharpen measurable outcome | Optional single-turn completion |

**Note:** Phase 1 Node already saves goals without AI. Python optional for “AI assist” button.

---

### B. Map Resistance (goal-scoped diagnostic QA) — **Phase 2**

| Task | Python responsibility |
|------|----------------------|
| Goal-scoped Q&A | 12–15 questions (or 25 with preamble) anchored to `ACTIVE_GOAL_CONTEXT` |
| System prompt | `stage1_map_resistance` + Brain Prompt + injected domain/goal/milestones |
| Next question generation | Same pattern as diagnostic numbered Q |
| Finalize extraction | `extract_domain_structure(transcript, goal_context)` → `GOAL_DIAGNOSIS_OUTPUT` |
| Output fields | `signature_id`, EO, lack, avoid, `failure_strategy`, `top_3_avoidance_behaviours`, `success_strategy`, `daily_rep`, `win_condition`, protector, rule, fear, cost, CL |

**Diagnostic question shift:**

> Old: “What is this person’s structure?”  
> New: “What structure activates when they try to achieve **this specific goal**?”

---

### C. Daily Coach + Friction — **Phase 4**

| Task | Python responsibility |
|------|----------------------|
| Coach check-in reply | `POST /ai/coach/reply` — inputs: `domain_map`, `COACH_CHECKIN`, user message |
| State-aware coaching | Abducted \| High Gravity \| Clear + Able \| Progress |
| One Green Rep per turn | Enforce in prompt + post-parse validator |
| Friction rescue | `POST /ai/friction/rescue` — 1–2 turns, short |
| Training pick (Stage 2) | `POST /ai/training/recommend` — one `TRAINING_RECOMMENDATION` |

**Coach must read:** failure strategy, protector, rule, fear, success strategy, current milestone, proof history.

---

### D. Brain Prompt V2 engines — **Phase 6**

Implement as **sections in Brain prompt** + **structured output parsers** where needed:

| Engine | Python module (suggested) |
|--------|---------------------------|
| Active Goal Context | Always injected from Node payload |
| Goal-Specific Onboarding | `engines/onboarding.py` |
| Goal-Specific Resistance Diagnosis | `engines/goal_diagnosis.py` |
| Failure Strategy Library | `data/failure_strategies.json` + classifier |
| Success Strategy Builder | `engines/success_strategy.py` |
| Milestone Resistance Mapping | `engines/milestone.py` (MVP: goal-level only) |
| 30-Day Treatment Plan | `engines/treatment_plan_30d.py` |
| Daily Coach State | `engines/coach_state.py` |
| Green Rep selection | `engines/green_rep.py` |
| Proof Logging (copy coaching) | Prompt only; Node stores `PROOF_LOG` |
| Home / Domains summary text | Optional `engines/dashboard_copy.py` |
| Suggested Training | `engines/training_recommendation.py` |
| State Vector V2 | Validate JSON against schema before Node writeback |

**Shadow prompts:** Python reads `prompts` table (or env) with `version=v2` / `is_active` flag per environment.

---

### E. Legacy flows (keep working during migration)

| Flow | Python service |
|------|----------------|
| Paid diagnostic 25Q | `DiagnosticIntakeService` |
| Discovery chat | `DiscoveryChatService` |
| Discovery report | `DiscoveryReportService` |
| Funnel IRL + extraction | `IrlReportService`, `StructuredExtractionService` |
| Freeform finalize (socket) | `ReportFinalizeService` |

---

## Prompt inventory

### Current (Postgres `prompts` table — Python reads)

| `type` | Used for |
|--------|----------|
| `Brain Prompt` | All paid + coach + diagnosis |
| `Diagnostic` | 25Q intake, report sections |
| `Diagnostic Chat` | Discovery mode |
| `Discovery` | Legacy |
| `invisible_red_line_report` | Funnel IRL |
| `stage1_constraint_extraction` | Funnel structured packet |

### New (seed + activate in shadow first)

| `type` | Phase |
|--------|-------|
| `Brain Prompt V2` | 6 — goal-specific OS |
| `stage1_goal_intake` | 1–2 optional |
| `stage1_map_resistance` | 2 |
| `stage1_daily_coach` | 4 |
| `stage1_friction_rescue` | 4 |
| `goal_specific_diagnostic` | 2 (alias or merge with map_resistance) |
| `treatment_plan_30d` | 7 |
| `coach_v2` | 6 |
| `suggested_training` | 7 |

**Prompt loading:** Cache 60s like Node `getLatestPromptFromDb` / `getPromptByType`; invalidate on admin update webhook.

---

## Flows to implement in Python

### 1. Diagnostic intake (paid — legacy + bridge)

```text
Input:  transcript[], user profile, optional prior report
Output: next_assistant_message | finalize_ready | confidence + suggested_focus
        on finalize: report_text, metrics{}, sections 1–10
```

Steps per turn:
1. Load Brain + Diagnostic prompts  
2. Append transcript + RAG (optional)  
3. Call LLM (gpt-4o / gpt-4o-mini per step)  
4. Parse Q number / CB number  
5. If confidence < 85% and CB < 6 → generate CB question  
6. If finalize → full report pipeline  

---

### 2. Map Resistance intake (Stage 1 — new)

```text
Input:  ACTIVE_GOAL_CONTEXT, transcript[], domain
Output: next_question | finalize_ready
        on finalize: GOAL_DIAGNOSIS_OUTPUT JSON
```

---

### 3. Coach turn (Stage 1 — new)

```text
Input:  domain_map, COACH_CHECKIN, messages[], user_message
Output: assistant_message, green_rep?, proof_prompt?, training_rec?
```

---

### 4. Discovery chat + report (legacy)

```text
Chat:   prior report snippet + discovery chat prompt
Report: 10 sections, metrics extraction, refusal retry logic
```

---

### 5. Funnel IRL (unchanged product; can stay Node or move)

```text
Input:  structured packet + invisible_red_line_report prompt + Brain
Output: irl report text (1000–1600 words), word count guard + retry
```

---

### 6. Extraction services (JSON out)

| Service | Input | Output schema |
|---------|-------|---------------|
| `extract_structured_packet` | report + transcript | funnel packet (existing) |
| `extract_domain_structure` | transcript + goal | `GOAL_DIAGNOSIS_OUTPUT` |
| `extract_metrics_from_report` | report text | gravity, CL, QGC, etc. |
| `generate_treatment_plan` | goal + diagnosis | `30_DAY_PLAN` |

---

## API contract (Node ↔ Python)

Base URL: `AI_SERVICE_URL` (e.g. `http://localhost:8000`)

### Synchronous HTTP (recommended for MVP)

| Method | Path | Called by Node when |
|--------|------|-------------------|
| POST | `/v1/chat/turn` | Socket `user_message` / REST diagnostic |
| POST | `/v1/chat/finalize` | Intake complete / user asks report |
| POST | `/v1/map-resistance/turn` | Stage 1 map resistance socket |
| POST | `/v1/map-resistance/finalize` | Map resistance complete |
| POST | `/v1/coach/reply` | `POST /api/stage1/coach/checkin` |
| POST | `/v1/friction/rescue` | `POST /api/stage1/friction` |
| POST | `/v1/extraction/domain-structure` | After map resistance |
| POST | `/v1/extraction/metrics` | After any report |
| POST | `/v1/treatment-plan/generate` | Stage 2 |
| POST | `/v1/training/recommend` | Stage 2 |
| POST | `/v1/onboarding/suggest-milestones` | Optional UI assist |
| POST | `/v1/irl/generate` | Funnel complete (optional move) |
| GET | `/health` | Deploy check |

### Example: coach reply request

```json
{
  "user_id": 123,
  "domain_map": { "domain": "income", "goal_title": "...", "failure_strategy": "...", "success_strategy": "..." },
  "checkin": {
    "current_state": "high_gravity",
    "gravity_rating": 7,
    "current_milestone": "Funnel live"
  },
  "messages": [{ "role": "user", "content": "I keep refining the page" }],
  "prompt_version": "v2"
}
```

### Example: coach reply response

```json
{
  "assistant_message": "...",
  "green_rep": { "action": "Send launch date to Lee", "win_condition": "Date sent" },
  "detected_failure_strategy": "DELAY_REFINEMENT",
  "writeback_hints": { "fear_identified": "Being seen before ready" }
}
```

Node merges `writeback_hints` into `metadata.stage1` and returns to client.

### WebSocket option

Alternative: Python hosts Socket.IO / FastAPI WS; Node only authenticates and passes `userId`. **Higher effort** — start with HTTP per turn.

---

## Python project structure (suggested)

```text
euphoriam-ai/
  app/
    main.py                 # FastAPI
    config.py
    routers/
      chat.py
      map_resistance.py
      coach.py
      extraction.py
      irl.py
    services/
      prompt_loader.py      # DB or S3 mirror of prompts
      llm.py                # OpenAI client
      diagnostic_intake.py
      discovery.py
      coach.py
      extraction/
        domain_structure.py
        structured_packet.py
        metrics.py
      engines/              # Brain V2 sections
        goal_diagnosis.py
        treatment_plan.py
        training.py
    guardrails/
      injection.py
      intent.py
      gibberish.py
    rag/
      chroma_client.py
      retrieve.py
    schemas/
      active_goal_context.py
      goal_diagnosis_output.py
      coach_checkin.py
      proof_log.py
  tests/
    test_map_resistance.py
    test_coach_states.py
    fixtures/
  prompts/                  # optional git mirror of DB seeds
```

**Stack:** FastAPI + uvicorn, `openai`, `pydantic`, `httpx`, `chromadb` or call existing Chroma HTTP, `asyncpg` or read-only SQLAlchemy for prompts.

---

## Phased build plan

| Phase | Python deliverable | Node depends on |
|-------|-------------------|-----------------|
| **PA0** | FastAPI skeleton, `/health`, config, OpenAI client | — |
| **PA1** | `POST /v1/chat/turn` + `/finalize` — parity with paid diagnostic | Node proxy from socket |
| **PA2** | Confidence + CB generation in Python | Remove CB LLM from Node |
| **PA3** | `map-resistance` turn + finalize + `extract_domain_structure` | Node `POST /stage1/map-resistance/finalize` |
| **PA4** | Coach + friction endpoints | Node stage1 coach/friction routes |
| **PA5** | Discovery chat + report in Python | Node discovery finalize calls Python |
| **PA6** | Brain V2 prompt + engines (Nathan text) | Shadow `prompt_version` |
| **PA7** | Treatment plan + training recommend | Node stage1 Phase 7 routes |
| **PA8** | RAG + injection guard full parity | Deprecate Node `rag.js` LLM paths |
| **PA9** | IRL + funnel extraction (optional move) | Funnel controller thin client |

### Migration strategy

1. **Strangler:** Node calls Python for **new** coach/map-resistance only; diagnostic still Node until PA1 passes tests.  
2. **Flip diagnostic:** Feature flag `AI_DIAGNOSTIC_PYTHON=true`.  
3. **Flip socket:** Node socket = auth + persist; every turn HTTP to Python.  
4. **Deprecate** OpenAI imports in Node controllers (keep PDF/email).

---

## Models, schemas & writeback

Python **returns** structured JSON; Node **persists**.

Key schemas (see master README):

- `ACTIVE_GOAL_CONTEXT`
- `ONBOARDING_OUTPUT` (optional AI assist)
- `GOAL_DIAGNOSIS_OUTPUT`
- `COACH_CHECKIN`
- `PROOF_LOG` (Node stores; Python may suggest fields)
- `30_DAY_PLAN`
- `TRAINING_RECOMMENDATION`
- `STATE_VECTOR_V2` (validate before PATCH to Node)

Use Pydantic models mirroring these names.

---

## Testing

| Test type | What |
|-----------|------|
| Unit | Prompt assembly, parsers, failure strategy classifier |
| Contract | Golden JSON for `GOAL_DIAGNOSIS_OUTPUT` on fixture transcript |
| Integration | Mock OpenAI; real Postgres prompt row (staging) |
| E2E | Income domain: goal → 12Q map resistance → extraction → coach High Gravity → Green Rep |
| Parity | Compare Node vs Python diagnostic output on same fixture (before cutover) |

```bash
pytest tests/
```

**Do not** require frontend for AI service CI.

---

## Do not move to Python

| Stay in Node | Reason |
|--------------|--------|
| JWT auth / middleware | API gateway |
| Sequelize models / migrations | Single DB owner |
| PDF (`diagnosticPdf`, `irlPdf`) | pdfkit pipeline wired to storage |
| Email (SendGrid/etc.) | Operational |
| Supabase upload | Storage keys |
| Kajabi webhooks / membership | Integration |
| `stage1` CRUD without LLM | Phase 1 done |
| Funnel access tokens / rate limits | Edge security |
| Admin user/list routes | Non-AI |

---

## Checklist — copy to tracker

```text
[ ] PA0 FastAPI + health
[ ] PA1 Diagnostic turn/finalize parity
[ ] PA2 CB + confidence in Python
[ ] PA3 Map resistance + domain extraction
[ ] PA4 Coach + friction
[ ] PA5 Discovery chat/report
[ ] PA6 Brain V2 + shadow prompts
[ ] PA7 Treatment plan + training
[ ] PA8 RAG + guards
[ ] Node: proxy wiring + feature flags
[ ] Deprecate Node openai in diagnosticController
```

---

*Last updated: split from [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md).*
