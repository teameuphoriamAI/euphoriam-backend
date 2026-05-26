# Euphoriam Stage 1 / V2 — Implementation Plan (Overview)

**For:** Yashal / backend (+ frontend coordination)  
**Full spec:** [EUPHORIAM-STAGE1-STAGE2-README.md](./EUPHORIAM-STAGE1-STAGE2-README.md)

> **Split by stack — use these to build:**
>
> - **[PYTHON-AI-IMPLEMENTATION.md](./PYTHON-AI-IMPLEMENTATION.md)** — All AI, QA, chat, prompts, RAG, extraction, coach LLM (migrate to Python)
> - **[NODEJS-IMPLEMENTATION.md](./NODEJS-IMPLEMENTATION.md)** — All Node.js files, REST, DB, PDF, email, Stage 1 APIs, Python proxy wiring

**Rule:** Node builds **data + APIs first**; Python owns **LLM turns**; Node proxies and persists.

---

## 1. What already exists (do not rebuild)

| Area                            | Status | Where                                                                      |
| ------------------------------- | ------ | -------------------------------------------------------------------------- |
| Auth / JWT                      | ✅     | `authRoutes`, middleware                                                   |
| User + `membership` JSONB       | ✅     | `userModel`, Kajabi sync in `userController`                               |
| Paid diagnostic Q&A (~25Q)      | ✅     | `diagnosticController`, socket `chatbotFreeformSocket`                     |
| Brain + Diagnostic prompts (DB) | ✅     | `Prompt` model, `getLatestPromptFromDb`                                    |
| Report PDF + email              | ✅     | `diagnosticPdf`, `sendEmail`                                               |
| Discovery chat + report         | ✅     | `handleDiscoveryMode`, `Discovery` model                                   |
| Chat transcript persist         | ✅     | `chatModel`, `saveChatIncrementally`                                       |
| Structured extraction (funnel)  | ✅     | `structuredPacketExtractor` — **reuse pattern** for goal-scoped extraction |
| Confidence / CB clarifiers      | ✅     | `calculateDiagnosticConfidence` in diagnostic flow                         |
| Funnel / IRL                    | ✅     | Separate — **leave unchanged**                                             |
| RAG chunks                      | ✅     | `retrieveSimilarChunks` — optional for coach later                         |

---

## 2. What is new (you must build)

| #   | New capability                         | Why                                                                |
| --- | -------------------------------------- | ------------------------------------------------------------------ |
| N1  | **5-domain enum** + validation         | Domain = select only                                               |
| N2  | **`domain_maps` per user**             | Goal + structure per domain (not one life report)                  |
| N3  | **Membership tier limits**             | Bronze 1 active / 3 stored, Silver 2, Accelerate 5                 |
| N4  | **Stage 1 REST API** (`/api/stage1/*`) | Home, domains, onboarding, coach, proof                            |
| N5  | **Goal onboarding** (save text fields) | Before Map Resistance                                              |
| N6  | **Goal-scoped Map Resistance**         | Diagnostic tied to active goal                                     |
| N7  | **Extraction → domain_map**            | Vortex, failure/success, daily rep                                 |
| N8  | **Coach loop**                         | Check-in, state, one Green Rep, writeback                          |
| N9  | **Proof logs + progress metrics**      | Home / Domains cards                                               |
| N10 | **30-day treatment plan** (Stage 2)    | After diagnosis                                                    |
| N11 | **Suggested Training** (Stage 2)       | Tagged library + one recommendation                                |
| N12 | **Brain Prompt V2** (shadow row)       | Paste after N1–N8 work                                             |
| N13 | **Socket routing change**              | Paid users without `domain_maps` → onboarding, not discovery-first |
| N14 | **Frontend** (4 tabs)                  | Home, Domains, Coach, Suggested Training                           |

---

## 3. Your first step (start here)

### Step 0 — Align (½ day)

- [ ] Confirm with Nathan/client: **MVP = 4 tabs**, **1 active domain** in UI (tier rules still in API).
- [ ] Confirm: new paid users go **Create Goals first**, or legacy users keep discovery until they onboard?
- [ ] Frontend repo ready to call `/api/stage1/home`?

### Step 1 — Foundation (this is **Day 1 backend work**)

**Goal:** Persist domains + goals with **no AI** yet. Frontend can show Home + empty state + “Create Goals”.

| Task | Action                                                                                                                                                       |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------- |
| 1.1  | Add `src/constants/domains.js` — enum + labels + `isValidDomain()`                                                                                           |
| 1.2  | Add `src/helpers/membershipDomains.js` — `getTier(user)`, `canActivateDomain()`, `maxStoredGoals()`                                                          |
| 1.3  | Add storage: **`users.metadata.stage1`** OR table `domain_maps` (recommended: start with `metadata.stage1` for speed, migrate to table in Phase 2 if needed) |
| 1.4  | Add `src/controllers/stage1Controller.js` + `src/routes/stage1Routes.js`                                                                                     |
| 1.5  | Register routes in `src/routes/index.js` → `router.use("/stage1", stage1Routes)`                                                                             |
| 1.6  | Implement **`GET /api/stage1/home`** — returns `{ membership_tier, active_domains, primary_domain, onboarding_status, dashboard                              | null }` |
| 1.7  | Implement **`GET /api/stage1/domains`** — list 5 domains with status: `active \| stored \| locked \| available`                                              |
| 1.8  | Implement **`POST /api/stage1/domains`** — create/update draft goal (domain required, goal fields optional)                                                  |
| 1.9  | Implement **`PATCH /api/stage1/domains/:domain/activate`** — enforce tier limits                                                                             |
| 1.10 | Postman/curl tests for all above                                                                                                                             | ✅      |

**Done when:** You can `POST` a goal for `income`, `activate` it, and `GET /home` shows today’s fields (even if null). **Backend: done.**

### Phase 1 API quick test (curl)

```bash
# Replace TOKEN and BASE (e.g. http://localhost:3000/api)
curl -H "Authorization: Bearer TOKEN" BASE/stage1/home
curl -H "Authorization: Bearer TOKEN" BASE/stage1/domains
curl -X POST -H "Authorization: Bearer TOKEN" -H "Content-Type: application/json" \
  -d '{"domain":"income","goal_title":"Launch funnel","desired_outcome":"25 UC sales","target_date":"90 days","proof_of_success":"Sales in Stripe","milestones":{"day_7":"Rollout","day_30":"Funnel live","day_90":"25 sales"},"today_visible_action":"Email Lee"}' \
  BASE/stage1/domains
curl -X PATCH -H "Authorization: Bearer TOKEN" BASE/stage1/domains/income/activate
curl -H "Authorization: Bearer TOKEN" BASE/stage1/domains/income
```

```text
FIRST COMMIT SCOPE = Step 1 only (constants + tier helper + stage1 routes + home/domains CRUD)
```

**Do not start yet:** Brain V2 paste, coach AI, Map Resistance socket, 30-day plan.

---

## 4. Phased plan (follow in order)

### Phase 1 — Data & Home API (Week 1)

Depends on: **Step 1 complete**

| #   | Task                                                                                                                                              | Done when                                  | Status      |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------ | ----------- |
| 1.1 | Goal onboarding fields on `domain_maps`: `goal_title`, `desired_outcome`, `target_date`, `proof_of_success`, `milestones`, `today_visible_action` | `POST`/`PATCH` saves all Stage 1 questions | ✅ Backend  |
| 1.2 | `onboarding_status`: `none → goals_draft → goals_complete → resistance_in_progress → active`                                                      | Status transitions in API                  | ✅ Backend  |
| 1.3 | `GET /api/stage1/domains/:domain` — full domain detail object                                                                                     | Frontend Domains tab can render            | ✅ Backend  |
| 1.4 | Frontend: **Create Goals** flow (select domain + form/chat for goal text)                                                                         | Calls your APIs only                       | ⬜ Frontend |
| 1.5 | Frontend: **Home** skeleton — Create Goals CTA + dashboard when `active`                                                                          | Wired to `GET /home`                       | ⬜ Frontend |

**Backend files added:** `src/constants/domains.js`, `src/helpers/membershipDomains.js`, `src/helpers/stage1State.js`, `src/controllers/stage1Controller.js`, `src/routes/stage1Routes.js`, `src/tests/stage1State.test.js`

---

### Phase 2 — Map Resistance (Week 2)

Depends on: Phase 1 + `goals_complete`

| #   | Task                                                                                                                                                                                                                                 | Done when                                                |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------- |
| 2.1 | Seed DB prompt `stage1_map_resistance` (stub OK) — inject `ACTIVE_GOAL_CONTEXT` from saved domain_map                                                                                                                                | Prompt row exists                                        |
| 2.2 | New endpoint or socket flag: `session.phase = 'map_resistance'`, `session.activeDomain`                                                                                                                                              | Paid socket does not force discovery if no `domain_maps` |
| 2.3 | Reuse diagnostic Q flow with **shorter target** (e.g. 12–15 questions) OR reuse 25 with goal preamble                                                                                                                                | Transcript saves on `Chat`                               |
| 2.4 | Add `extractDomainStructure()` helper (clone pattern from `structuredPacketExtractor`) → maps to `signature_id`, EO, lack, avoid, `failure_strategy`, `top_3_avoidance_behaviours`, `success_strategy`, `daily_rep`, `win_condition` | JSON merged into `domain_map`                            |
| 2.5 | `POST /api/stage1/map-resistance/finalize` — runs extraction + sets `map_resistance_complete`, `status: active`                                                                                                                      | Domain detail shows structure                            |
| 2.6 | Optional: domain PDF + email (lower priority than data)                                                                                                                                                                              | Nice-to-have                                             |

**Reuse:** `diagnosticController` finalize pattern, `Brain Prompt` + `Diagnostic` prompts (goal-scoped system message prefix).

---

### Phase 3 — Domains dashboard API (Week 2–3)

Depends on: Phase 2

| #   | Task                                                                                      | Done when               |
| --- | ----------------------------------------------------------------------------------------- | ----------------------- |
| 3.1 | `GET /api/stage1/domains/:domain/map` — EO, Lack, Avoid, orbit, protector, CL, strategies | Map sub-view works      |
| 3.2 | Frontend **Domains** tab — cards: goal, milestone, failure, success, rep                  | Reads domain detail API |
| 3.3 | Initialize `progress_metrics` defaults on activate                                        | Zeros in JSON           |

---

### Phase 4 — Daily Coach (Week 3–4)

Depends on: Phase 2 (`active` domain with diagnosis)

| #   | Task                                                                          | Done when                                  |
| --- | ----------------------------------------------------------------------------- | ------------------------------------------ |
| 4.1 | `coach_sessions` table or `metadata.stage1.coach_sessions[]`                  | Session persist                            |
| 4.2 | Seed prompt `stage1_daily_coach` (stub → Nathan full text later)              | DB row                                     |
| 4.3 | `POST /api/stage1/coach/checkin` — body: `state`, `gravity_rating`, `message` | Returns coach reply + optional `green_rep` |
| 4.4 | Inject into coach prompt: full `domain_map` + `COACH_CHECKIN`                 | Not generic chat                           |
| 4.5 | `POST /api/stage1/friction` — fast rescue (1–2 turn optional)                 | Home “I’m In Friction” works               |
| 4.6 | Socket `mode: coach` OR REST-only for MVP                                     | Product choice                             |
| 4.7 | Frontend **Coach** tab — state buttons + gravity + chat                       | E2E send message                           |

---

### Phase 5 — Proof & progress (Week 4)

Depends on: Phase 4

| #   | Task                                                                                              | Done when                         |
| --- | ------------------------------------------------------------------------------------------------- | --------------------------------- |
| 5.1 | `proof_logs` storage + `POST /api/stage1/proof`                                                   | Proof saved                       |
| 5.2 | `GET /api/stage1/progress/:domain` — aggregates: rep rate, recovery, avoidance caught, milestones | Home structural metrics update    |
| 5.3 | Coach writeback updates `progress_metrics` after proof                                            | Numbers change on second check-in |
| 5.4 | Frontend **Home** — structural + physical performance blocks                                      | Matches spec                      |

---

### Phase 6 — Brain V2 & prompts (Week 5)

Depends on: Phases 1–5 working without V2 text

| #   | Task                                                                               | Done when                   |
| --- | ---------------------------------------------------------------------------------- | --------------------------- |
| 6.1 | Tell Nathan **basics are built**                                                   | Email sent                  |
| 6.2 | Add **shadow** `Brain Prompt` row (inactive in prod) with V2 engines from README   | Staging uses V2             |
| 6.3 | Replace stubs: `stage1_goal_intake`, `stage1_map_resistance`, `stage1_daily_coach` | Quality pass                |
| 6.4 | Flip `isActive` on staging → test Income E2E                                       | Test doc in README §testing |

---

### Phase 7 — Stage 2 extras (Week 6+)

| #   | Task                                                                 | Done when                     |
| --- | -------------------------------------------------------------------- | ----------------------------- |
| 7.1 | `POST /api/stage1/treatment-plan/generate` — `30_DAY_PLAN` on domain | Domains card shows week focus |
| 7.2 | Training library + tags (admin)                                      | Resources taggable            |
| 7.3 | `GET /api/stage1/training/suggested` — one `TRAINING_RECOMMENDATION` | Suggested Training tab        |
| 7.4 | Milestone-level resistance fields (store only; one vortex MVP)       | Schema ready for later        |

---

## 5. Dependency diagram

```text
Step 1 (domain_maps API)
    ↓
Phase 1 (onboarding fields + Home FE)
    ↓
Phase 2 (Map Resistance + extraction)
    ↓
Phase 3 (Domains FE + map API)
    ↓
Phase 4 (Coach + friction)
    ↓
Phase 5 (Proof + progress + Home metrics)
    ↓
Phase 6 (Brain V2 prompts in shadow)
    ↓
Phase 7 (30-day plan + training)
```

---

## 6. Parallel work (frontend vs backend)

| Week | Backend              | Frontend                               |
| ---- | -------------------- | -------------------------------------- |
| 1    | **Step 1 + Phase 1** | Create Goals UI + Home empty/dashboard |
| 2    | Phase 2–3            | Domains tab + Map Resistance chat UI   |
| 3    | Phase 4              | Coach tab                              |
| 4    | Phase 5              | Home metrics + Log Proof               |
| 5    | Phase 6              | Copy/UX polish                         |
| 6+   | Phase 7              | Suggested Training tab                 |

---

## 7. Socket change (when to do it)

**After Step 1**, before Phase 2 user testing:

In `chatbotFreeformSocket.js` paid path (~line 1005):

```text
IF user has active domain_map with status active
  → mode coach or home (product)
ELSE IF user has any domain_map in progress
  → mode goal_onboarding / map_resistance
ELSE IF legacy aiReport only
  → show Create Goals (API flag) — optional keep discovery
ELSE
  → diagnostic (legacy) OR force Create Goals (product decision)
```

---

## 8. Minimal file checklist (Step 1)

Create these first:

```text
src/constants/domains.js
src/helpers/membershipDomains.js
src/controllers/stage1Controller.js
src/routes/stage1Routes.js
src/routes/index.js          (one line: use stage1)
```

Optional Step 1:

```text
src/models/domainMapModel.js   (if not using users.metadata.stage1)
```

---

## 9. API checklist (build in order)

| Order | Method | Path                                   |
| ----- | ------ | -------------------------------------- |
| 1     | GET    | `/api/stage1/home`                     |
| 2     | GET    | `/api/stage1/domains`                  |
| 3     | POST   | `/api/stage1/domains`                  |
| 4     | PATCH  | `/api/stage1/domains/:domain`          |
| 5     | PATCH  | `/api/stage1/domains/:domain/activate` |
| 6     | GET    | `/api/stage1/domains/:domain`          |
| 7     | POST   | `/api/stage1/map-resistance/finalize`  |
| 8     | GET    | `/api/stage1/domains/:domain/map`      |
| 9     | POST   | `/api/stage1/coach/checkin`            |
| 10    | POST   | `/api/stage1/friction`                 |
| 11    | POST   | `/api/stage1/proof`                    |
| 12    | GET    | `/api/stage1/progress/:domain`         |
| 13    | POST   | `/api/stage1/treatment-plan/generate`  |
| 14    | GET    | `/api/stage1/training/suggested`       |

---

## 10. What NOT to do early

- Do not paste full Brain V2 before Step 1 + home/domains work.
- Do not refactor legacy diagnostic/discovery until Map Resistance works.
- Do not change funnel / IRL.
- Do not build 7 tabs before 4-tab MVP works.
- Do not allow free-text domain enum.

---

## 11. Definition of “MVP shipped”

- [ ] Paid user: select **Income** → enter goal → save milestones
- [ ] Map Resistance completes → domain shows vortex + failure + success + rep
- [ ] Coach: pick state → get one Green Rep → log proof
- [ ] Home shows updated metrics
- [ ] (Stage 2) One suggested training with “why chosen”
- [ ] Legacy funnel unchanged
- [ ] Income domain E2E test passes

---

## 12. First step summary (copy to your task tracker)

```text
TODAY — Step 1: Foundation (no AI)
  1. domains.js enum
  2. membershipDomains.js tier limits
  3. stage1 routes + controller
  4. Persist domain_maps on user.metadata.stage1 (or new table)
  5. GET /home, GET/POST/PATCH /domains, PATCH activate
  6. Test with curl/Postman

NEXT — Phase 1: Fill onboarding fields + frontend Create Goals
THEN  — Phase 2: Map Resistance + extraction
```

---

_See [EUPHORIAM-STAGE1-STAGE2-README.md](./EUPHORIAM-STAGE1-STAGE2-README.md) for full product spec and schemas._  
_Stack-specific tasks: [PYTHON-AI-IMPLEMENTATION.md](./PYTHON-AI-IMPLEMENTATION.md) · [NODEJS-IMPLEMENTATION.md](./NODEJS-IMPLEMENTATION.md)_
