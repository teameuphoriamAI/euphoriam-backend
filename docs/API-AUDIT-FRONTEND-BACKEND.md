# Frontend ↔ Backend API audit (euphoriam-frontend + euphoriam-backend)

**Last run:** 2026-05-26  
**Purpose:** After merge conflicts removed route/helper files, verify every **euphoriam-frontend** proxy call has a matching **euphoriam-backend** handler.

---

## Summary

| Area | Frontend calls | Backend mounted | Status |
|------|----------------|-----------------|--------|
| Auth / login | `POST /api/diagnostics/checkUser` | ✅ `diagnosticRoutes` | ✅ |
| Free funnel | `GET/POST /api/funnel/*` | ✅ `funnelRoutes` (re-added) | ✅ |
| Stage 1 (paid) | `GET/POST/PATCH /api/stage1/*` | ✅ `stage1Routes` (re-added) | ✅ |
| Admin | `GET/POST/PUT/DELETE /api/admin/*` | ✅ `adminRoutes` | ✅ |
| Admin login | `POST /api/auth/login` | ✅ `authRoutes` | ✅ |

**Re-created in this repo (were missing):**

- `src/routes/index.js` → `router.use("/stage1", stage1Routes)`
- `src/routes/index.js` → `router.use("/funnel", funnelRoutes)`
- `src/constants/domains.js`
- `src/helpers/membershipDomains.js`
- `src/helpers/structuredPacketExtractor.js`
- `src/routes/funnelRoutes.js` + `funnelController.js` + `funnelAccess.js` + `funnelToken.js` + `funnelAuth.js`

---

## 1. Auth (paid + free)

| Frontend | Backend | Notes |
|----------|---------|--------|
| `POST /api/diagnostic/checkUser` → `POST /api/diagnostics/checkUser` | `diagnosticRoutes` `POST /checkUser` | Paid UC → JWT. Non-UC → `funnel_redirect` + link (re-added). |

---

## 2. Free funnel (`/api/funnel`)

| Frontend path | Backend | Status |
|---------------|---------|--------|
| `GET access-status` | `GET /api/funnel/access-status` | ✅ |
| `POST validate-token` | `POST /api/funnel/validate-token` | ✅ (not used by v2 UI yet) |
| `GET diagnostics` | `GET /api/funnel/diagnostics` | ✅ |
| `POST start-diagnostic` | `POST /api/funnel/start-diagnostic` | ✅ |
| `POST socket-session` | `POST /api/funnel/socket-session` | ✅ |
| `GET chats` | `GET /api/funnel/chats` | ✅ |
| `GET chat/:chatId` | `GET /api/funnel/chat/:chatId` | ✅ |
| `GET report/:id` | `GET /api/funnel/report/:diagnosticId` | ✅ |
| `GET report/:id/pdf` | `GET /api/funnel/report/:diagnosticId/pdf` | ✅ |
| `POST resend-report` | `POST /api/funnel/resend-report` | ⚠️ 501 stub |
| `GET expired` | `GET /api/funnel/expired` | ✅ |

**Not REST (separate):** Free Q&A uses Socket.IO `GET {BACKEND}/ws/chatbot-freeform` — existing socket; funnel-specific socket auth/report pipeline is still minimal.

---

## 3. Stage 1 (`/api/stage1`) — euphoriam-frontend `stage1-client.ts`

| Frontend path | Backend route | Status |
|---------------|---------------|--------|
| `GET home` | `GET /home` | ✅ |
| `GET domains` | `GET /domains` | ✅ |
| `POST domains` | `POST /domains` | ✅ |
| `GET domains/:domain` | `GET /domains/:domain` | ✅ |
| `PATCH domains/:domain` | `PATCH /domains/:domain` | ✅ |
| `PATCH domains/:domain/activate` | `PATCH /domains/:domain/activate` | ✅ |
| `POST domains/:domain/map-resistance/chat` | `POST .../map-resistance/chat` | ✅ |
| `POST domains/:domain/map-resistance/finalize` | `POST .../map-resistance/finalize` | ✅ |
| `GET map-resistance/history` | `GET /map-resistance/history` | ✅ |
| `GET domains/:domain/map-resistance/history` | `GET .../map-resistance/history` | ✅ |
| `PATCH walkthrough/complete` | `PATCH /walkthrough/complete` | ✅ |
| `POST coach/checkin` | `POST /coach/checkin` | ✅ |
| `GET coach/history` | `GET /coach/history` | ✅ |
| `GET coach/resume` | `GET /coach/resume` | ✅ |
| `POST friction` | `POST /friction` | ✅ |
| `POST proof` | `POST /proof` | ✅ |
| `GET progress/:domain` | `GET /progress/:domain` | ✅ |

**Backend only (frontend does not call):**

| Backend route | Status |
|---------------|--------|
| `GET /onboarding/status` | ✅ optional |

**Documented but not implemented (frontend does not call yet):**

| Planned API | Status |
|-------------|--------|
| `GET /domains/:domain/map` | ❌ not built |
| `POST /treatment-plan/generate` | ❌ Stage 2 |
| `GET /training/suggested` | ❌ no nav in frontend |

---

## 4. Admin (`/api/admin`)

| Frontend | Backend | Status |
|----------|---------|--------|
| `POST /api/admin/login` → `/api/auth/login` | `authRoutes` | ✅ |
| `GET prompts`, CRUD | `adminRoutes` | ✅ |
| `GET users` | `adminRoutes` | ✅ |
| `GET stats` | `adminRoutes` | ✅ |

Admin panel does not call user-sessions / getMonthlystats from v2 UI (routes exist on backend).

---

## 5. Not used by euphoriam-frontend (do not mount broken routers)

| File | Issue |
|------|--------|
| `src/routes/purchaseRoutes.js` | References missing `purchaseController.js` |
| `src/routes/productRoutes.js` | References missing `productController.js` |

Leave unmounted until controllers are restored.

---

## 6. Helper / module checklist (Stage 1 + funnel)

All **required** imports for mounted routes:

| Module | Present |
|--------|---------|
| `constants/domains.js` | ✅ |
| `helpers/membershipDomains.js` | ✅ |
| `helpers/structuredPacketExtractor.js` | ✅ |
| `helpers/stage1State.js` | ✅ |
| `helpers/stage1Repository.js` | ✅ |
| `helpers/stage1GoalContext.js` | ✅ |
| `helpers/stage1MapResistance*.js` | ✅ |
| `helpers/stage1Proof.js` | ✅ |
| `helpers/stage1CoachHistory.js` | ✅ |
| `helpers/stage1Prompts.js` | ✅ |
| `helpers/stage1SuccessStrategy.js` | ✅ |
| `helpers/stage1ProgressMetrics.js` | ✅ |
| `models/domainGoalModel.js` | ✅ |
| `models/userStage1MetaModel.js` | ✅ |
| `helpers/funnelAccess.js` | ✅ |
| `helpers/funnelToken.js` | ✅ |
| `clients/aiService.js` | ✅ |

**Still missing (old docs, not required for current frontend):**

| Module | Impact |
|--------|--------|
| `funnelAccessModel.js` | Using raw SQL in `funnelAccess.js` instead |
| `irlReportGenerator.js` | Funnel IRL PDF via socket not fully wired |
| `funnelTranscriptNormalize.js`, `funnelRateLimit.js` | Optional |
| `purchaseController.js`, `productController.js` | Commerce routes unused |

---

## 7. Env vars (frontend → backend)

**euphoriam-frontend**

```env
BACKEND_URL=http://localhost:3001
NEXT_PUBLIC_BACKEND_URL=http://localhost:3001
```

**euphoriam-backend**

```env
DATABASE_URL=...
JWT_ACCESS_SECRET=...
FRONTEND_URL=http://localhost:3000
AI_SERVICE_URL=http://localhost:8000
USE_PYTHON_COACH=true
USE_PYTHON_MAP_RESISTANCE=true
```

---

## 8. Quick smoke test

```bash
# Backend health
curl http://localhost:3001/api/health

# Funnel (Bearer funnel JWT from login / validate-token)
curl -H "Authorization: Bearer FUNNEL_JWT" http://localhost:3001/api/funnel/access-status

# Stage 1 (Bearer UC JWT)
curl -H "Authorization: Bearer UC_JWT" http://localhost:3001/api/stage1/home
```

If you see `Route not found`, the route is not registered in `src/routes/index.js` or the server was not restarted after pulling fixes.
