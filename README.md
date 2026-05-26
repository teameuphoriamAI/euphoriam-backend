# Euphoriam Backend (Node.js)

API and services for **Euphoriam AI**: user accounts, paid diagnostics, chat persistence, funnel reports, Kajabi membership, and **Stage 1** goal-based coaching (domains, goals, coach, proof).

A separate **Python AI service** will handle all LLM work (questions, chat replies, reports, extraction). This repo stays the **system of record** — database, auth, PDF, email, and REST.

---

## Python vs Node — simple split

|              | **Python (new service)**                                                    | **Node.js (this repo)**                          |
| ------------ | --------------------------------------------------------------------------- | ------------------------------------------------ |
| **Role**     | AI thinks and writes                                                        | App saves data and runs the business             |
| **Examples** | Next diagnostic question, full report text, coach reply, Map Resistance Q&A | Login, save goals, membership limits, PDF, email |

```text
Frontend  →  Node.js (auth, /api/stage1, save chat)  →  Python (OpenAI) when AI is needed
                ↓
            Postgres, Supabase, SendGrid
```

### Put in **Python** (detailed)

| Feature                 | What the user sees                             | What Python does                                                                                                     |
| ----------------------- | ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| **Diagnostic QA**       | First paid flow: Q1…Q25 (+ clarifiers CB1–6)   | Loads Brain + Diagnostic prompts; asks next question; checks confidence; writes **full diagnostic report** + metrics |
| **Diagnostic chat**     | Live back-and-forth during that QA (socket)    | Each user message → AI reply (next question, etc.)                                                                   |
| **Map Resistance QA**   | Q&A about **one goal** in one domain (Stage 1) | Questions tied to their goal; at end outputs vortex, failure strategy, success strategy, daily rep                   |
| **Discovery chat**      | Chat after they already have a report          | Answers using old report + discovery prompts                                                                         |
| **Discovery report**    | “End chat” → update report                     | Generates follow-up report text                                                                                      |
| **Coach chat**          | Coach tab: state, gravity, conversation        | Goal-aware coaching; **one Green Rep**; not generic advice                                                           |
| **Friction**            | “I’m stuck” quick help                         | Short rescue: name pattern → one success move                                                                        |
| **Extraction**          | (behind the scenes)                            | Transcript/report → JSON (signatures, strategies, etc.)                                                              |
| **30-day plan**         | Plan on Domains (Stage 2)                      | Generates weekly focus + daily reps                                                                                  |
| **Suggested training**  | One UC/Silver pick (Stage 2)                   | Picks one class + why                                                                                                |
| **IRL / funnel report** | Free lead hidden-structure report              | Long IRL text (can move from Node later)                                                                             |
| **RAG**                 | (behind the scenes)                            | Search vector DB; add context to prompts                                                                             |
| **Guards**              | (behind the scenes)                            | Prompt injection, gibberish, “end chat / generate report” intent                                                     |

Python **does not** send email, store users, or upload PDFs — it returns text/JSON; Node saves and delivers.

### Keep in **Node.js** (this repo)

| Area                   | What it does                                                                                               |
| ---------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Auth**               | Login, JWT, OTP                                                                                            |
| **Users & membership** | Profile; Bronze / Silver / Creator Club (Kajabi)                                                           |
| **Stage 1 APIs**       | Create Goals: **select** domain (5 options), **enter** goal text; home, activate domain, onboarding status |
| **Database**           | Users, diagnostics, discoveries, chats, `users.metadata.stage1`                                            |
| **After AI**           | Save report, transcript, update `domain_map`, proof logs, progress counts                                  |
| **PDF & email**        | Diagnostic/discovery/domain PDFs; report emails                                                            |
| **Storage**            | Supabase upload                                                                                            |
| **Funnel**             | Access tokens, rate limits, complete pipeline (may call Python for IRL text)                               |
| **Socket gateway**     | Authenticate; persist messages; **call Python** per turn; emit reply                                       |
| **Admin**              | Non-AI admin routes; prompt rows in DB (Python reads content)                                              |

---

## Documentation

| Read this                                                                                | When you need                                                                                                     |
| ---------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| **[docs/FLOW-PYTHON-AND-NODE.md](docs/FLOW-PYTHON-AND-NODE.md)**                         | **Start here for flows** — login, paid QA, discovery, free 3-in-7, new Stage 1 (simple language + Node vs Python) |
| **[docs/NODEJS-IMPLEMENTATION.md](docs/NODEJS-IMPLEMENTATION.md)**                       | Every file in this repo, Node phases, APIs to build, socket routing                                               |
| **[docs/PYTHON-AI-IMPLEMENTATION.md](docs/PYTHON-AI-IMPLEMENTATION.md)**                 | Python service design, migrate list, `/v1/...` API contract                                                       |
| **[docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)**                           | Combined timeline (both stacks)                                                                                   |
| **[docs/EUPHORIAM-STAGE1-STAGE2-README.md](docs/EUPHORIAM-STAGE1-STAGE2-README.md)**     | Full client spec (Stage 1, V2 MVP, Brain V2, schemas)                                                             |
| [chatbotDiagnosticFreeform-documentation.md](chatbotDiagnosticFreeform-documentation.md) | Legacy diagnostic REST flow (today in Node)                                                                       |

---

## Goals vs domains

|                | Domain                                           | Goal                                        |
| -------------- | ------------------------------------------------ | ------------------------------------------- |
| **User input** | **Select** one of five                           | **Type** their own words (guided questions) |
| **Values**     | Income, Alignment, Relationships, Health, Wealth | e.g. “Launch funnel + 25 sales in 90 days”  |

---

## User flows

### Today (paid)

```text
Login → Diagnostic Q&A (~25) → Report (PDF + email) → Chat ends
     → Return: Discovery chat → End chat → Discovery report + email
```

_AI for Q&A and reports is in Node today; moving to Python._

### Target (Stage 1 + V2)

```text
Login → Create Goals (domain + goal) → Map Resistance (Python QA)
     → Domain dashboard → Daily Coach (Python) → Log proof (Node)
     → Home metrics → Suggested training (Python pick, Node stores)
```

### Free funnel (unchanged product)

Funnel lead → IRL report. Still wired in Node (`/api/funnel`); IRL **text** can move to Python later.

---

## Stage 1 API (live)

Base: `/api/stage1` · Auth: `Authorization: Bearer <JWT>`

| Method | Path                        | Description                                    |
| ------ | --------------------------- | ---------------------------------------------- |
| GET    | `/home`                     | Dashboard, onboarding status, Create Goals CTA |
| GET    | `/domains`                  | All five domains + status                      |
| GET    | `/domains/:domain`          | Full domain map                                |
| POST   | `/domains`                  | Create/update goals                            |
| PATCH  | `/domains/:domain`          | Update goals; `begin_map_resistance: true`     |
| PATCH  | `/domains/:domain/activate` | Set active domain (tier limits)                |
| GET    | `/onboarding/status`        | Wizard helper                                  |

Storage: **`domain_goals`** table (one row per user + domain, normalized goal columns) and **`user_stage1_meta`** (primary domain, active list, walkthrough). Legacy `users.metadata.stage1.domain_maps` is auto-migrated on first load.

**Planned on Node (proxy to Python):** `/map-resistance/finalize`, `/coach/checkin`, `/friction`, `/proof`, `/progress/:domain`, `/training/suggested`.

---

## Project layout (high level)

```text
index.js, src/app.js          # Server
src/routes/                   # /api/* (auth, users, diagnostics, stage1, funnel, …)
src/controllers/              # Handlers (stage1 = no AI; diagnostic = AI today)
src/models/                   # Sequelize models
src/socket/                   # Chat socket (→ Python later)
src/helpers/                  # stage1State, membershipDomains, euphoriamChatbot (→ thin)
src/constants/domains.js      # Five domains enum
docs/                         # Implementation & product specs
```

---

## API docs (Swagger)

With the server running:

| URL                                             | Purpose      |
| ----------------------------------------------- | ------------ |
| **http://localhost:PORT/api/docs**              | Swagger UI   |
| **http://localhost:PORT/api/docs/openapi.json** | OpenAPI JSON |

Includes **Stage 1** (`/stage1/*`) plus **frontend-used** routes (`checkUser`, chat, funnel, etc.) with Next.js proxy notes.

**Test Stage 1:**

1. `POST /diagnostics/checkUser` — paid UC email → copy `result.token`
2. **Authorize** → paste token
3. Run `/stage1/home` → `POST /stage1/domains` → `PATCH /stage1/domains/income/activate`

---

## Getting started

### Requirements

- Node.js (see `package.json`)
- PostgreSQL (`DATABASE_URL`)
- `.env` — JWT secrets, DB, OpenAI (until Python cutover), Supabase, etc.

### Run

```bash
npm install
npm run dev          # nodemon
# or
npm start
```

Health: `GET /api/health`

### Tests

```bash
npm test
npm run test:irl-pdf   # Funnel IRL PDF (DB + OpenAI; not Stage 1)
```

### Example: Stage 1 (after login)

```bash
export TOKEN="your-jwt"
export BASE="http://localhost:PORT/api"

curl -H "Authorization: Bearer $TOKEN" "$BASE/stage1/home"
curl -X POST -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"domain":"income","goal_title":"Launch funnel","desired_outcome":"25 UC sales","target_date":"90 days","proof_of_success":"Stripe sales","milestones":{"day_7":"Rollout","day_30":"Funnel live","day_90":"25 sales"},"today_visible_action":"Email Lee"}' \
  "$BASE/stage1/domains"
curl -X PATCH -H "Authorization: Bearer $TOKEN" "$BASE/stage1/domains/income/activate"
```

---

## Environment (planned Python integration)

```env
AI_SERVICE_URL=http://localhost:8000
USE_PYTHON_DIAGNOSTIC=false
USE_PYTHON_MAP_RESISTANCE=true
USE_PYTHON_COACH=true
```

When flags are `true`, Node calls Python instead of local OpenAI in diagnostic/socket/coach paths.

---

## Implementation status

| Feature                          | Where               | Status             |
| -------------------------------- | ------------------- | ------------------ |
| Auth, users, Kajabi membership   | Node                | Live               |
| Diagnostic QA + chat + discovery | Node (→ Python)     | Live, migrating    |
| Funnel / IRL                     | Node                | Live               |
| Stage 1 goals + home APIs        | Node                | **Live** (Phase 1) |
| Map Resistance, coach, proof     | Python + Node proxy | Planned            |
| Brain Prompt V2                  | Python + DB prompts | Spec ready         |

---

## What to build next

1. **Node:** `AI_SERVICE_URL` client + `POST /stage1/map-resistance/finalize` (see [NODEJS-IMPLEMENTATION.md](docs/NODEJS-IMPLEMENTATION.md) Phase 2).
2. **Python:** FastAPI + diagnostic `turn` / `finalize` parity (see [PYTHON-AI-IMPLEMENTATION.md](docs/PYTHON-AI-IMPLEMENTATION.md) PA0–PA1).
3. **Frontend:** Create Goals + Home wired to `/api/stage1`.

---

## License

ISC — see `package.json`.
