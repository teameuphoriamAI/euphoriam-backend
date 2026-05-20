# euphoriam-backend

Backend API and services for **Euphoriam AI**: diagnostics, paid chat, discovery, funnel / Invisible Red Line reports, Kajabi membership, and (planned) Stage 1 / V2 goal-specific coaching.

---

## Documentation

| Document | Description |
|----------|-------------|
| **[docs/IMPLEMENTATION-PLAN.md](docs/IMPLEMENTATION-PLAN.md)** | **Start here** — step-by-step build order, existing vs new, first step (foundation APIs) |
| **[docs/EUPHORIAM-STAGE1-STAGE2-README.md](docs/EUPHORIAM-STAGE1-STAGE2-README.md)** | **Master spec** — Document 1 (Stage 1), Document 2 (V2 MVP + Stage 2), Nathan Brain Prompt V2, goals vs domains FAQ, schemas, APIs, backend plan, migration, testing |
| [chatbotDiagnosticFreeform-documentation.md](chatbotDiagnosticFreeform-documentation.md) | Current diagnostic / discovery REST + chat flow |

---

## Quick reference

### Paid user flow (today)

```text
Login → Diagnostic Q&A (~25) → Report (PDF + email) → Chat ends
     → Return: Discovery chat → End chat → Discovery report + email
```

### Planned paid flow (Stage 1 + V2)

```text
Login → Create Goals (select domain, enter goal) → Map Resistance → Domain dashboard
     → Daily Coach (Green Rep + proof) → Home metrics → Suggested Training
```

### Goals vs domains

| | Domain | Goal |
|--|--------|------|
| **Input** | **Select** 1 of 5 | **Enter** (guided questions) |
| **Values** | income, alignment, relationships, health, wealth | User’s own wording |

### Free funnel

Unchanged — IRL two-stage report (`npm run test:irl-pdf` for local PDF test).

---

## Key paths

| Area | Location |
|------|----------|
| Paid socket | `src/socket/chatbotFreeformSocket.js` |
| Diagnostic / discovery | `src/controllers/diagnosticController.js` |
| Funnel / IRL | `src/controllers/funnelController.js`, `src/helpers/irlReportGenerator.js` |
| Prompts (DB) | `Prompt` model — Brain Prompt, Diagnostic, IRL, etc. |
| Membership | `src/controllers/userController.js`, Kajabi |

---

## Scripts

```bash
npm run test:irl-pdf   # Live DB + OpenAI — generates IRL report PDF (funnel prompt, not Stage 1)
```

---

## Stage 1 API (Phase 1 — live)

All routes require `Authorization: Bearer <JWT>`. Base path: `/api/stage1`.

| Method | Path | Description |
|--------|------|-------------|
| GET | `/home` | Dashboard + `onboarding_status` |
| GET | `/domains` | Five domains with status |
| GET | `/domains/:domain` | Full domain map |
| POST | `/domains` | Create/update goals (`domain` required) |
| PATCH | `/domains/:domain` | Update goals; `begin_map_resistance: true` to start Map Resistance |
| PATCH | `/domains/:domain/activate` | Set active domain (tier limits) |
| GET | `/onboarding/status` | Wizard helper |

Data stored on `users.metadata.stage1`.

## Implementation status

| Feature | Status |
|---------|--------|
| Legacy diagnostic + discovery | **Live** |
| Funnel / IRL | **Live** |
| Stage 1 Phase 1 APIs + `domain_maps` | **Live** — see table above |
| Stage 1 Map Resistance / Coach | **Planned** — Phase 2+ |
| Brain Prompt V2 (goal-specific) | **Spec ready** — shadow DB prompts after Phase 2 |
