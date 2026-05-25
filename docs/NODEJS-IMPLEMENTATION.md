# Node.js API — Implementation Plan

**Purpose:** Everything that stays in **`euphoriam-backend`** (Express, Sequelize, auth, REST, PDF, email, storage, integrations) plus **new Stage 1 / V2 product APIs** that do not call the LLM directly (or only proxy to Python).

**Companion doc:** [PYTHON-AI-IMPLEMENTATION.md](./PYTHON-AI-IMPLEMENTATION.md) — QA, chat AI, prompts execution, extraction, coach LLM.  
**Product spec:** [EUPHORIAM-STAGE1-STAGE2-README.md](./EUPHORIAM-STAGE1-STAGE2-README.md)  
**Original combined plan:** [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md)

---

## Table of contents

1. [Architecture split](#architecture-split)
2. [Complete file map (this repo)](#complete-file-map-this-repo)
3. [What exists today](#what-exists-today)
4. [New requirements — Node only](#new-requirements--node-only)
5. [New requirements — Node + Python proxy](#new-requirements--node--python-proxy)
6. [Stage 1 API reference](#stage-1-api-reference)
7. [Phased build plan](#phased-build-plan)
8. [Database & storage](#database--storage)
9. [Socket layer (gateway)](#socket-layer-gateway)
10. [Integrations](#integrations)
11. [Frontend contract](#frontend-contract)
12. [Environment variables](#environment-variables)
13. [Testing](#testing)
14. [What leaves Node eventually](#what-leaves-node-eventually)

---

## Architecture split

```text
Frontend
   │
   ├─► /api/auth, /api/users, /api/stage1, /api/diagnostics …  (Node)
   ├─► /api/funnel …                                            (Node)
   └─► Socket.IO chatbot-freeform                               (Node gateway → Python AI)

Node persists:  users, diagnostics, discoveries, chat, metadata.stage1, PDF URLs
Python returns: next message, reports, extraction JSON, coach text
```

**You own in Node:** truth of user state, membership, when chat ends, when to email PDF.

---

## Complete file map (this repo)

### Entry & app

| File | Role |
|------|------|
| `index.js` | HTTP server, CORS, `initDb`, Chroma init |
| `src/app.js` | Express app, `/api` mount, error handler |

### Routes (mount under `/api`)

| File | Prefix | Role |
|------|--------|------|
| `src/routes/index.js` | `/` | Aggregator + health |
| `src/routes/authRoutes.js` | `/auth` | Login, refresh |
| `src/routes/userRoutes.js` | `/users` | Profile, OTP, theme |
| `src/routes/diagnosticRoutes.js` | `/diagnostics` | Diagnostic REST |
| `src/routes/discoveryRoutes.js` | `/discoveries` | Discovery list |
| `src/routes/chatRoutes.js` | `/chat` | Chat history, save |
| `src/routes/funnelRoutes.js` | `/funnel` | Funnel access, complete |
| `src/routes/stage1Routes.js` | `/stage1` | **Stage 1 CRUD (Phase 1 ✅)** |
| `src/routes/adminRoutes.js` | `/admin` | Admin, prompts |
| `src/routes/kajabi.js` | `/kajabi` | Kajabi hooks |
| `src/routes/ragRoutes.js` | `/rag` | RAG admin (→ Python later) |
| `src/routes/voiceRoutes.js` | `/voice-notes` | Voice upload |
| `src/routes/productRoutes.js` | `/products` | Products |
| `src/routes/purchaseRoutes.js` | `/purchases` | Purchases |
| `src/routes/barcodeRoutes.js` | `/barcode` | Barcode |

### Controllers

| File | Role | AI in file? |
|------|------|-------------|
| `authController.js` | Auth | No |
| `userController.js` | Users, profile, Kajabi membership | No |
| `diagnosticController.js` | Diagnostic + discovery (**large, AI today**) | **Yes → proxy Python** |
| `discoveryController.js` | List discoveries | No |
| `chatController.js` | Chat CRUD | No |
| `funnelController.js` | Funnel pipeline | Yes (IRL) → optional Python |
| `stage1Controller.js` | Stage 1 home/domains | No ✅ |
| `adminController.js` | Admin dashboards | Partial |
| `kajabi.js` | Kajabi API | No |
| `ragController.js` | RAG endpoints | Yes → Python |
| `voiceController.js` | Voice | Maybe |
| `barcodeController.js` | Barcode | No |

### Models

| File | Table / role |
|------|----------------|
| `userModel.js` | `users` (+ `metadata` JSONB for `stage1`) |
| `diagnosticModel.js` | `diagnostics` |
| `discoveryModel.js` | `discoveries` |
| `chatModel.js` | `chat` |
| `promptModel.js` | `prompts` |
| `funnelAccessModel.js` | `funnel_access` |
| `coachingSessionModel.js` | Coaching sessions |
| `productModel.js`, `purchaseModel.js`, … | Commerce |

### Stage 1 (new — Phase 1 ✅)

| File | Role |
|------|------|
| `src/constants/domains.js` | 5-domain enum |
| `src/helpers/membershipDomains.js` | Bronze / Silver / Accelerate limits |
| `src/helpers/stage1State.js` | `metadata.stage1` read/write, onboarding status |
| `src/controllers/stage1Controller.js` | REST handlers |
| `src/routes/stage1Routes.js` | Routes |
| `src/tests/stage1State.test.js` | Unit tests |

### Helpers & utils (mostly migrate AI out)

| File | Stay in Node? |
|------|----------------|
| `stage1State.js`, `membershipDomains.js`, `domains.js` | **Yes** |
| `asyncHandler.js`, `validate.js`, `response.js` | **Yes** |
| `diagnosticPdf.js`, `irlPdf.js` | **Yes** |
| `email.js`, `emailTemplate/*` | **Yes** |
| `storage.js` (Supabase) | **Yes** |
| `tokens.js`, `funnelToken.js` | **Yes** |
| `funnelTranscriptNormalize.js`, `funnelRateLimit` | **Yes** |
| `euphoriamChatbot.js` | **Thin wrapper → Python** |
| `structuredPacketExtractor.js` | **Proxy → Python** |
| `irlReportGenerator.js` | **Proxy → Python** (optional) |
| `rag.js`, `chromadb.js` | **Proxy → Python** |
| `promptInjectionGuard.js` | **Proxy → Python** |
| `metricsCalculator.js` | **Yes** or Python metrics endpoint |
| `marketResearchAggregator.js` | Admin; Python optional |

### Socket

| File | Role |
|------|------|
| `src/socket/index.js` | Socket.IO init |
| `src/socket/chatbotFreeformSocket.js` | Paid + funnel chat (**gateway after migration**) |

### Config

| File | Role |
|------|------|
| `sequelize.js` | DB init, seeds, IRL prompt seed |
| `openai.js` | **Remove usage over time** |
| `chromadb.js`, `Embedding.js` | **Python** |
| `supabase.js` | **Node** |

---

## What exists today

| Feature | Status | Node owner |
|---------|--------|------------|
| JWT auth | ✅ | `auth`, `userController` |
| Kajabi membership on user | ✅ | `user.membership` |
| Paid diagnostic REST + socket | ✅ | `diagnosticController`, socket |
| Discovery chat + report | ✅ | `diagnosticController` |
| Chat persist | ✅ | `chatController`, `chatModel` |
| Funnel IRL 2-stage | ✅ | `funnelController`, `irlReportGenerator` |
| Admin / prompts in DB | ✅ | `adminController`, `promptModel` |
| PDF + email | ✅ | `diagnosticPdf`, `email` |
| **Stage 1 Phase 1 APIs** | ✅ | `stage1Controller` |

---

## New requirements — Node only

No LLM — implement entirely in Node.

### Phase 1 ✅ (done)

| Item | Status |
|------|--------|
| Domain enum + validation | ✅ `domains.js` |
| `users.metadata.stage1` + `domain_maps[]` | ✅ `stage1State.js` |
| Membership tier limits | ✅ `membershipDomains.js` |
| `GET /stage1/home` | ✅ |
| `GET/POST/PATCH /stage1/domains` | ✅ |
| `PATCH .../activate` | ✅ |
| `GET /stage1/onboarding/status` | ✅ |
| Onboarding status machine | ✅ |

### Phase 3 — Domains dashboard API

| # | Task | File |
|---|------|------|
| 3.1 | `GET /stage1/domains/:domain/map` — return structure fields from `domain_map` (no AI) | `stage1Controller.js` |
| 3.3 | Ensure `progress_metrics` initialized on activate | `stage1State.js` |

### Phase 5 — Proof & progress (data only)

| # | Task | File |
|---|------|------|
| 5.1 | `proof_logs` in `metadata.stage1` or table `proof_logs` | new model optional |
| 5.2 | `POST /stage1/proof` | `stage1Controller.js` |
| 5.3 | `GET /stage1/progress/:domain` — aggregate from proof + metrics | `stage1Progress.js` helper |
| 5.4 | Update `progress_metrics` on proof (no LLM) | `stage1State.js` |

### Phase 7 — Training library (admin + read)

| # | Task | File |
|---|------|------|
| 7.2 | Admin CRUD training resources + tags | `adminController` + model |
| 7.3 | `GET /stage1/training/suggested` — **calls Python**, stores last rec on user | `stage1Controller` thin |

### Infrastructure

| # | Task |
|---|------|
| I1 | `AI_SERVICE_URL` + `src/clients/aiService.js` HTTP client with timeout |
| I2 | Feature flags: `USE_PYTHON_DIAGNOSTIC`, `USE_PYTHON_COACH` |
| I3 | Error mapping: Python 5xx → 502 to frontend |
| I4 | Optional: `domain_maps` table migration from JSONB |
| I5 | Accelerate tier in Kajabi mapper |

### Frontend-facing (not in this repo)

| # | Task | Owner |
|---|------|-------|
| 1.4 | Create Goals UI | Frontend |
| 1.5 | Home dashboard UI | Frontend |
| 3.2 | Domains tab | Frontend |
| 4.7 | Coach tab | Frontend |
| 5.4 | Home metrics UI | Frontend |

---

## New requirements — Node + Python proxy

Node route receives request → loads user + `domain_map` → HTTP to Python → merges result → saves DB → responds.

| Phase | Node endpoint | Python endpoint | Node after response |
|-------|---------------|-----------------|---------------------|
| 2 | `POST /stage1/map-resistance/finalize` | `/v1/map-resistance/finalize` | Merge `GOAL_DIAGNOSIS_OUTPUT` into `domain_map`, `map_resistance_complete` |
| 2 | Socket map resistance turns | `/v1/map-resistance/turn` | Append transcript to `Chat` |
| 4 | `POST /stage1/coach/checkin` | `/v1/coach/reply` | Optional append coach session log |
| 4 | `POST /stage1/friction` | `/v1/friction/rescue` | Log friction event |
| 6 | — | Brain V2 (prompts in DB) | Node unchanged; Python reads prompts |
| 7 | `POST /stage1/treatment-plan/generate` | `/v1/treatment-plan/generate` | Save `treatment_plan_30d` on domain_map |
| 7 | `GET /stage1/training/suggested` | `/v1/training/recommend` | Save `last_training_recommendation` |
| Legacy | Socket `user_message` | `/v1/chat/turn` | Save transcript |
| Legacy | Finalize diagnostic | `/v1/chat/finalize` | Create `Diagnostic`, PDF job |
| Funnel | `completeDiagnostic` | `/v1/irl/generate` + extraction | Optional move |

### New file: `src/clients/aiService.js`

```javascript
// POST ${AI_SERVICE_URL}/v1/coach/reply
// headers: X-Request-Id, optional X-Internal-Key
```

### Phase 2 — Map Resistance (Node tasks)

| # | Task | Owner |
|---|------|-------|
| 2.1 | Seed prompt row in DB (content can be empty stub; Python loads it) | Node admin/sequelize seed |
| 2.2 | Socket routing: no discovery if no `domain_maps`; `phase: map_resistance` | `chatbotFreeformSocket.js` |
| 2.3 | Persist transcript on `Chat` with `chatType` or `data.phase` | `chatController.js` |
| 2.5 | `POST /stage1/map-resistance/finalize` handler | `stage1Controller.js` |
| 2.6 | Optional PDF: `generateDomainMapPdf` | `utils/domainPdf.js` new |

---

## Stage 1 API reference

**Base:** `/api/stage1`  
**Auth:** `Authorization: Bearer <JWT>`

### Live (Phase 1 ✅)

| Method | Path | Body / notes |
|--------|------|----------------|
| GET | `/home` | Dashboard, `onboarding_status`, `show_create_goals_cta` |
| GET | `/domains` | All 5 domains + status |
| GET | `/domains/:domain` | Full `map` or `available` |
| POST | `/domains` | `{ domain, goal_title?, desired_outcome?, ... }` |
| PATCH | `/domains/:domain` | Partial update; `begin_map_resistance: true` |
| PATCH | `/domains/:domain/activate` | Tier check |
| GET | `/onboarding/status` | Wizard helper |

### Planned (Node shell)

| Method | Path | Phase |
|--------|------|-------|
| POST | `/map-resistance/finalize` | 2 |
| GET | `/domains/:domain/map` | 3 |
| POST | `/coach/checkin` | 4 |
| POST | `/friction` | 4 |
| POST | `/proof` | 5 |
| GET | `/progress/:domain` | 5 |
| POST | `/treatment-plan/generate` | 7 |
| GET | `/training/suggested` | 7 |

### Storage shape (`users.metadata.stage1`)

See [EUPHORIAM-STAGE1-STAGE2-README.md](./EUPHORIAM-STAGE1-STAGE2-README.md) § JSON writeback.

---

## Phased build plan

| Phase | Node work | Status |
|-------|-----------|--------|
| **0** | Align product (4 tabs, legacy discovery) | ⬜ |
| **1** | Stage 1 foundation APIs | ✅ |
| **2** | `aiService` client + map-resistance finalize + socket routing | ⬜ |
| **3** | `/domains/:domain/map` + progress defaults | ⬜ |
| **4** | Coach/friction routes (proxy) + coach session log | ⬜ |
| **5** | Proof + progress aggregation | ⬜ |
| **6** | Prompt seeds in DB; feature flag for Python Brain V2 | ⬜ |
| **7** | Treatment plan + training proxy + admin tags | ⬜ |
| **8** | Thin diagnostic socket (Python only) + remove Node OpenAI imports | ⬜ |

### Dependency diagram (Node)

```text
Phase 1 ✅
    ↓
aiService client + Phase 2 finalize/socket
    ↓
Phase 3 map GET
    ↓
Phase 4 coach/friction proxy
    ↓
Phase 5 proof/progress
    ↓
Phase 7 training admin + proxy
    ↓
Phase 8 diagnostic strangler to Python
```

---

## Database & storage

### Tables (existing)

- `users` — add/use `metadata.stage1`
- `diagnostics`, `discoveries`, `chat`, `prompts`, `funnel_access`, …

### Optional new tables (Phase 5+)

| Table | Columns (minimal) |
|-------|-------------------|
| `proof_logs` | `id`, `userId`, `domain`, `payload` JSONB, `createdAt` |
| `coach_sessions` | `id`, `userId`, `domain`, `transcript` JSONB, `checkin` JSONB |
| `domain_maps` | Normalize from JSONB if querying needed |
| `training_resources` | `title`, `source`, `tags` JSONB, `url` |

### Sequelize

- Migrations in `src/config/sequelize.js` or separate migration files (follow repo convention).
- Seeds: new prompt types for stage1 (stubs).

### Supabase

- PDF upload paths: `diagnostics/`, `funnel-reports/`, future `domain-maps/`
- Node `uploadBufferToSupabase` unchanged

---

## Socket layer (gateway)

**File:** `src/socket/chatbotFreeformSocket.js`

### Current behaviour

- Paid + `aiReport` → `mode: discovery`
- No report → diagnostic
- Funnel → locked diagnostic

### Target behaviour (Phase 2+)

```text
on connection:
  load user.metadata.stage1 + legacy Diagnostic

  if funnel token → funnel (unchanged)

  else if active domain_map with map_resistance_complete
    → emit ready { mode: 'coach' }   // or REST-only coach

  else if goals_complete && map_resistance_in_progress
    → emit ready { mode: 'map_resistance', domain }

  else if no domain_maps && legacy aiReport
    → emit ready { mode: 'discovery' } OR force create_goals (product)

  else if no domain_maps
    → emit ready { mode: 'create_goals' }

  else
    → emit ready { mode: 'map_resistance' | 'goals' }

on user_message:
  if mode in (diagnostic, discovery, map_resistance, coach):
    POST AI_SERVICE /v1/.../turn
    persist transcript
    emit assistant_message
```

**Node keeps:** inactivity timeout, funnel rate limit, injection block (or delegate to Python response).

---

## Integrations

| Integration | Node files | Notes |
|-------------|------------|-------|
| Kajabi | `kajabi.js`, `userController` | Membership → tier |
| SendGrid/email | `utils/email.js` | Reports, OTP |
| Supabase storage | `utils/storage.js` | PDFs |
| Supabase webhook | `webhooks/supabaseWebhook.js` | If used |
| Chroma | `chromadb.js` | Deprecate after Python RAG |

---

## Frontend contract

### Stage 1 flows (calls Node only for CRUD)

1. `GET /stage1/home` → show CTA or dashboard  
2. `POST /stage1/domains` → Create Goals wizard steps  
3. `PATCH .../activate` → pick active domain  
4. `PATCH .../begin_map_resistance` or socket → Map Resistance chat  
5. `POST .../map-resistance/finalize` → Domains detail populated  
6. `POST /stage1/coach/checkin` → Coach tab  
7. `POST /stage1/proof` → Log proof  

### Legacy (until migrated)

- Socket connect + `user_message` for diagnostic/discovery  
- Or REST `POST /diagnostics/chatbot-diagnostic-freeform`

---

## Environment variables

```env
# Existing
DATABASE_URL=
JWT_ACCESS_SECRET=
JWT_REFRESH_SECRET=
OPENAI_API_KEY=          # deprecate in Node after Python cutover

# New
AI_SERVICE_URL=http://localhost:8000
AI_SERVICE_INTERNAL_KEY=  # optional HMAC between Node and Python
USE_PYTHON_DIAGNOSTIC=false
USE_PYTHON_MAP_RESISTANCE=false
USE_PYTHON_COACH=false

# Unchanged
SUPABASE_*=
UC_SALES_URL=
```

---

## Testing

| Test | File / command |
|------|----------------|
| Stage 1 state | `npm test -- stage1State` |
| Stage 1 routes | Add `src/tests/stage1Api.test.js` with supertest |
| aiService client | Mock `nock` Python responses |
| Funnel / IRL | Existing tests unchanged |
| Integration | Manual curl — see IMPLEMENTATION-PLAN Phase 1 curl block |

```bash
npm test
npm run test:irl-pdf   # still Node IRL until moved
```

---

## What leaves Node eventually

| Module | After Python PA1–PA8 |
|--------|----------------------|
| `openai` calls in `diagnosticController` | Removed |
| `euphoriamChatbot.js` LLM assembly | Thin HTTP client |
| `structuredPacketExtractor.js` | Proxy |
| `irlReportGenerator.js` | Proxy or stay for PDF-only pipeline |
| `rag.js`, `chromadb` init in `index.js` | Removed or optional |
| `promptInjectionGuard` LLM paths | Python |

| **Never leave Node** | |
|--------------------|---|
| Auth, stage1 CRUD, models, PDF, email, funnel access, Kajabi, socket auth/persist |

---

## Checklist — Node tracker

```text
✅ Phase 1 — stage1 APIs + metadata.stage1
⬜ aiService.js client + env
⬜ Phase 2 — map-resistance finalize + socket routing
⬜ Phase 3 — GET .../map
⬜ Phase 4 — coach/friction proxy routes
⬜ Phase 5 — proof + progress
⬜ Phase 6 — prompt seeds + flags
⬜ Phase 7 — training admin + suggested proxy
⬜ Phase 8 — diagnostic socket → Python only
⬜ Frontend coordination (separate repo)
```

---

*Last updated: split from [IMPLEMENTATION-PLAN.md](./IMPLEMENTATION-PLAN.md).*
