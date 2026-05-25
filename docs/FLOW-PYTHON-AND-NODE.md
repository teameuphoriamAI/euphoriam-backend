# Euphoriam flows — explained simply (Python vs Node)

**One document.** Read this like a story: what the user does, what **Node** does (this repo), what **Python** does (AI service you will build).

Words we use:
- **Node** = the app brain that remembers users, saves answers, sends email and PDF.
- **Python** = the talking brain that asks smart questions and writes long reports.

---

## Table of contents

1. [Big picture](#big-picture)
2. [Login — always Node](#login--always-node)
3. [Paid user — first time (Diagnostic QA)](#paid-user--first-time-diagnostic-qa)
4. [Paid user — after report (Discovery chat)](#paid-user--after-report-discovery-chat)
5. [Free user (Funnel) — 3 reports in 7 days](#free-user-funnel--3-reports-in-7-days)
6. [New flow (Stage 1 + V2) — Create Goals to Coach](#new-flow-stage-1--v2--create-goals-to-coach)
7. [Cheat sheet](#cheat-sheet)

---

## Big picture

```text
                    ┌─────────────┐
   User / App  ───► │    NODE     │  login, save data, rules, PDF, email
                    │  (this repo)│
                    └──────┬──────┘
                           │  "What should AI say?"
                           ▼
                    ┌─────────────┐
                    │   PYTHON    │  questions, chat replies, report text
                    │  (new app)  │
                    └─────────────┘
```

**Rule:** If it needs **OpenAI / thinking / writing a report**, it goes to **Python** (soon). If it needs **database, rules, or email**, it stays on **Node**.

---

## Login — always Node

**What the user does:** Enters email (and password or OTP). Gets into the app.

**What Node does:**
- Checks who they are.
- Gives them a **token** (like a wristband) so the app knows them on every request.
- Loads their **membership** (paid Creator Club? Bronze? Silver?).
- If they are **not** a paid member, Node may send them to the **free funnel** link instead of full paid chat.

**What Python does:** Nothing. Login is not AI.

```text
User opens app → Node: "OK, you are Sarah, you are Bronze" → front end shows Home
```

---

## Paid user — first time (Diagnostic QA)

This is the **first big chat** when they **do not have a diagnostic report yet**.

### Story for the user

1. They open chat.
2. The coach asks **25 main questions** (Q1, Q2, … Q25) — one at a time.
3. After Q25, the system checks: **“Do we understand them well enough?”** (this is called **confidence**, a score out of 100).
4. If confidence is **not high enough yet** (in the app today: **below 85%**), the coach asks up to **6 extra questions** (CB1 … CB6) to clear things up.
5. When confidence is **high enough (≥ 85%)** OR they have finished those 6 extras, the intake **stops**.
6. The app **writes the big diagnostic report**, makes a **PDF**, and **emails** it.
7. The chat is **closed**. They cannot keep asking in that same intake chat.

*(You said “80” — in code the stop point is **85%** confidence. Same idea: “good enough → stop asking and make the report.”)*

### Who does what (today vs target)

| Step | What happens | **Node** | **Python** (target) |
|------|----------------|----------|---------------------|
| 1 | User connects to chat (socket) | Checks token, loads user | — |
| 2 | User answers Q1…Q25 | Saves each message in `chat` | **Asks next question** (AI reply each turn) |
| 3 | After Q25, check confidence | Runs check (today in Node; **move to Python**) | **Scores confidence** |
| 4 | If confidence &lt; 85%, ask CB1–CB6 | Saves messages; **move AI to Python** | **Writes clarifier questions** |
| 5 | Confidence ≥ 85% or 6 CBs done | Decides “time to finish” | Says “ready to finalize” |
| 6 | Generate full report text | Today: Node calls OpenAI → **Python** | **Writes whole report** |
| 7 | Save report | Saves on `diagnostics` table | Sends text back to Node |
| 8 | Make PDF | `diagnosticPdf.js` | — |
| 9 | Email PDF | `sendEmail` | — |
| 10 | Tell user “done” | Socket/API response | — |

### Picture — first-time paid

```text
User: "Here is my answer to Q5"
   │
   ▼
NODE: save message in database
   │
   ▼
PYTHON: "Thanks. Here is Q6: ..."
   │
   ▼
NODE: send Q6 to user's screen
   ... repeat until Q25 (+ CB if needed) ...
   │
   ▼
PYTHON: write full diagnostic report
   │
   ▼
NODE: save report → PDF → email → end chat
```

### Domain & goal here?

**Not yet.** Old paid flow is a **general life diagnostic**, not “one goal in Income.” That comes in the **new flow** below.

---

## Paid user — after report (Discovery chat)

This is when they **already have** a diagnostic report and come back to talk.

### Story for the user

1. They open chat again.
2. The app **shows they have a report** and can use **latest metrics** (gravity, signal, etc.) from that report and any past discovery updates.
3. Chat is **freeform** — they ask things like “What does my orbit mean?” or “I felt stuck this week.”
4. The AI talks like a **follow-up coach**, using their **saved report**, not starting Q1–Q25 again.
5. When they say they want to **end chat** or **generate report** (or the app detects that intent), the app makes a **new discovery report**, PDF, and often **email**.

### Who does what

| Step | What happens | **Node** | **Python** (target) |
|------|----------------|----------|---------------------|
| 1 | User opens chat | Sees `aiReport` exists → mode = **discovery** (not Q1–Q25 again) | — |
| 2 | Load context | Loads last diagnostic + last discovery + **metrics** for prompts | — |
| 3 | User sends message | Saves to `chat` | **Reply** using report + metrics + discovery prompt |
| 4 | Show “latest metrics” on UI | **Node/API** sends metrics JSON from DB (from report / discovery) | May **explain** metrics in chat text |
| 5 | User: “end chat” / generate report | Detects intent (today Node; can be Python) | Can help classify intent |
| 6 | Write discovery report | Today Node OpenAI → **Python** | **Writes discovery report** |
| 7 | Save + PDF + email | `Discovery` row, PDF, email | Returns text to Node |

### Picture — discovery

```text
User already has Report #1 saved in Node
   │
   ▼
NODE: "You are in discovery mode" + pass metrics + report snippet to Python
   │
   ▼
PYTHON: normal conversation about THEIR structure
   │
   User: "End chat, give me an update"
   ▼
PYTHON: new discovery report text
   ▼
NODE: save → PDF → email
```

**Python** = conversation + new report words.  
**Node** = memory of old report, metrics storage, PDF, email.

---

## Free user (Funnel) — 3 reports in 7 days

This is **not** the same as paid. Free users get the **Invisible Red Line (IRL)** / hidden-structure path, with **limits**.

### Story for the user

1. They are **not** full paid members (or Node sends them here from signup).
2. They get a **special link** (funnel link, often 10-day link validity).
3. When they **first start**, a **7-day window** opens.
4. Inside those 7 days they can complete up to **3** full diagnostic runs (3 reports).
5. Each run: **only the 25 questions** — **no** CB1–CB6 extras (funnel keeps it simpler).
6. After Q25 is answered → system generates **IRL report** (not the same long paid PDF sections) → PDF → email.
7. If they used **3 reports** OR **7 days** passed → **locked**. Message like: upgrade to Unlimited Creator. **No more free QA.**

### Rules (from Node code)

| Rule | Value |
|------|--------|
| Max free full runs | **3** (`MAX_DIAGNOSTICS`) |
| Access window | **7 days** from first use (`ACCESS_WINDOW_DAYS`) |
| Questions per run | **25 only** (no clarifier CB phase on funnel) |
| Report type | **IRL** / hidden structure map |
| After lock | QA blocked; upsell |

### Who does what — free funnel

| Step | What happens | **Node** | **Python** (target) |
|------|----------------|----------|---------------------|
| 1 | Open funnel link | Validates funnel token, `FunnelAccess` row | — |
| 2 | Check 3-in-7 | `checkAccess` — block if limit or expired | — |
| 3 | Chat Q1–Q25 | Saves transcript; funnel mode locked | **Each question + reply** |
| 4 | After Q25 | Auto finalize (no CB) | **Stage 1 text report** for IRL |
| 5 | Structured extract | Today Node `extractStructuredPacket` | **Python** extraction JSON |
| 6 | IRL long report | Today Node `irlReportGenerator` | **Python** IRL body |
| 7 | PDF + email | `generateIrlReportPdf`, email | — |
| 8 | Count +1 toward 3 | Updates `diagnostics_completed_count` | — |
| 9 | 4th try or day 8 | Node returns **locked** — no new QA | — |

### Picture — free user

```text
Free user with token
   │
   ▼
NODE: "You have 2 reports left, 5 days left"
   │
   ▼
PYTHON: Q1…Q25 conversation
   │
   ▼
PYTHON: IRL report + structured fields
   │
   ▼
NODE: PDF + email + count 1 of 3
   │
   If 3/3 or 7 days over:
NODE: "Locked — upgrade" (Python not called)
```

**Important:** Free funnel **does not** use paid discovery or Stage 1 Create Goals. Product stays separate.

---

## New flow (Stage 1 + V2) — Create Goals to Coach

This is for **paid users** inside the app — **outcome first**, not “diagnose my whole life first.”

### Story for the user (simple steps)

1. **Login** → Node.
2. Tap **Create Goals**.
3. **Pick a domain** (Income, Health, …) — only 5 choices, not free typing.
4. **Type their goal** — what they want, by when, proof, 90/30/7-day steps, today’s action. Node saves (Phase 1 **done**).
5. **Map Resistance** — chat Q&A about **this goal only** (like diagnostic but shorter and focused).
6. App learns **failure strategy**, **success strategy**, **daily rep** → saved on their domain card.
7. **Home** shows today’s action and strategies.
8. **Coach tab** — daily check-in; AI helps with one small action (**Green Rep**) and proof.
9. Later: **Suggested training** — one class pick (Stage 2).

### Step-by-step: Node vs Python

#### A. Create Goals (no AI required)

| Step | User | **Node** | **Python** |
|------|------|----------|------------|
| A1 | Login | Auth, membership | — |
| A2 | Open Home | `GET /api/stage1/home` | — |
| A3 | Pick domain + type goal | `POST /api/stage1/domains`, `PATCH activate` | Optional: suggest milestones button |
| A4 | Saved | `users.metadata.stage1` | — |

#### B. Map Resistance (goal QA)

| Step | User | **Node** | **Python** |
|------|------|----------|------------|
| B1 | Start Map Resistance | `begin_map_resistance: true`, open chat | — |
| B2 | Answer questions about **this goal** | Save transcript on `chat` | **Ask questions** (goal in prompt) |
| B3 | Done | `POST /map-resistance/finalize` | **Extract** vortex, failure strategy, success strategy, rep |
| B4 | See domain page | Merge JSON into `domain_map` | — |
| B5 | Optional PDF/email | PDF + email if you add it | — |

*Paid old 25Q is “whole life.” Map Resistance is “what stops **this** goal.”*

#### C. Daily Coach

| Step | User | **Node** | **Python** |
|------|------|----------|------------|
| C1 | Pick state (stuck / clear / …) | Save check-in | — |
| C2 | Chat with coach | Save messages | **Coach reply** + one Green Rep |
| C3 | Log proof (“I sent the email”) | `POST /proof`, update metrics | Optional: encourage proof sentence |
| C4 | Home numbers update | `GET /progress`, `GET /home` | — |

#### D. Friction (quick help)

| Step | User | **Node** | **Python** |
|------|------|----------|------------|
| D1 | “I’m in friction” | `POST /friction` | Short **rescue** reply |
| D2 | Save | Log event | — |

#### E. Suggested training (Stage 2)

| Step | User | **Node** | **Python** |
|------|------|----------|------------|
| E1 | Open training tab | Load tagged courses from DB | **Pick one** + why |
| E2 | Show link | Return URL + title | — |

### Picture — new paid flow (full)

```text
LOGIN ─────────────────────────────► NODE only

CREATE GOALS (pick domain, type goal) ► NODE saves

MAP RESISTANCE QA ───────────────────► PYTHON asks + extracts
                                      NODE saves result on domain

COACH CHAT + PROOF ──────────────────► PYTHON talks
                                      NODE saves proof & scores

HOME / DOMAINS screens ──────────────► NODE reads saved data
```

### How new flow relates to old paid flow

| | Old paid | New Stage 1 |
|--|----------|-------------|
| Start | 25Q life diagnostic | Create Goals first |
| Focus | General structure | One goal in one domain |
| After | Discovery chat | Coach + proof |
| Free funnel | Unchanged | Unchanged |

*Product choice:* Keep old discovery for legacy users, or push everyone to Create Goals — decide with client.

---

## Cheat sheet

### Always **Node**

- Login, JWT, membership  
- Save users, chats, diagnostics, discoveries, `metadata.stage1`  
- Funnel: 3 reports / 7 days / lock  
- PDF, email, Supabase  
- Kajabi, admin, `/api/stage1` goals (no AI)  
- Call Python and save what comes back  

### Always **Python** (when migrated)

- Diagnostic Q1–Q25 + CB1–CB6 until confidence ≥ **85%**  
- Diagnostic chat replies (each turn)  
- Diagnostic report **text**  
- Discovery chat replies  
- Discovery report **text**  
- Funnel Q1–Q25 + IRL report **text** + extraction JSON  
- Map Resistance Q&A + structure extraction  
- Coach + friction replies  
- 30-day plan + training recommendation text  
- RAG search for context  

### Numbers to remember

| Flow | Questions | Extra | Stop when | Reports |
|------|-----------|-------|-----------|---------|
| **Paid diagnostic** | 25 | Up to 6 CB if confidence &lt; 85% | Confidence ≥ 85% or 6 CB done | 1 diagnostic PDF + email |
| **Discovery** | Free chat | — | User ends / generate | 1 discovery update + email |
| **Free funnel** | 25 only | No CB | Q25 answered | Up to **3** IRL in **7 days**, then **lock** |
| **Map Resistance (new)** | ~12–15 (or 25 scoped) | TBD | Intake complete | Fields on domain (optional PDF) |

---

## What to read next

| Doc | For |
|-----|-----|
| [README.md](../README.md) | Repo entry + short split |
| [NODEJS-IMPLEMENTATION.md](./NODEJS-IMPLEMENTATION.md) | All Node files and tasks |
| [PYTHON-AI-IMPLEMENTATION.md](./PYTHON-AI-IMPLEMENTATION.md) | Python service APIs and phases |
| [EUPHORIAM-STAGE1-STAGE2-README.md](./EUPHORIAM-STAGE1-STAGE2-README.md) | Full product spec |

---

*Written in plain language for the team. Confidence threshold and funnel limits match `euphoriam-backend` code today.*
