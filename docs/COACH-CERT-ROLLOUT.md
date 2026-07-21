# Coach Certification Rollout — Phase 1 & Phase 2

Operational checklist for merging, deploying, and signing off the coach certification upgrade.

## Branch matrix

| Repo | Feature branch | Staging target |
|------|----------------|----------------|
| backend | `feature/coach-cert-upgrade-v1` | `test` |
| frontend | `feature/coach-cert-upgrade-v1` | `master` |
| ai-worker | `feature/coach-cert-upgrade-v1` | `main` |

## Phase 1 — Open PRs and merge

```bash
# Backend → test
cd backend
git push -u origin feature/coach-cert-upgrade-v1
gh pr create --base test --head feature/coach-cert-upgrade-v1 \
  --title "Coach certification upgrade (Phase 1)" \
  --body "Session intake, friction handoff, cert UI, local dev UC bypass. See docs/COACH-CERTIFICATION-SPEC.md"

# Frontend → master
cd frontend
git push -u origin feature/coach-cert-upgrade-v1
gh pr create --base master --head feature/coach-cert-upgrade-v1 \
  --title "Coach certification UI (Phase 1)" \
  --body "Intention-led coach open, friction banner, resume restore, Start coach fix."

# AI worker → main
cd ai-worker
git push -u origin feature/coach-cert-upgrade-v1
gh pr create --base main --head feature/coach-cert-upgrade-v1 \
  --title "Coach certification prompts (Phase 1)" \
  --body "Intake, resistance probe, yes-man reframe rules in prompts.py."
```

Merge after review. Confirm staging env has `USE_PYTHON_COACH=true`.

## Phase 1 — DB voice overlays (staging)

```bash
cd backend
node src/scripts/applyCoachCertPromptV1.js --dry-run   # preview
node src/scripts/applyCoachCertPromptV1.js             # apply on staging DB
```

Code guardrails remain in `ai-worker/app/services/prompts.py`. DB rows tune voice only.

## Phase 1 — Staging acceptance

Run all three scenarios in [coach-cert-samples.md](./coach-cert-samples.md) on staging (Income domain, map complete):

| # | Check |
|---|-------|
| 1 | Coach opens with intention question, not generic "how are things" |
| 2 | Body/pressure language acknowledged when shared |
| 3 | Stuck/overwhelmed handled without quantum or framework jargon |
| 4 | Green Rep + proof cycle unchanged after integration |
| 5 | Friction → coach carries `friction_context` |

Also verify: 4-state picker, same-day intention skip, yes-man reframe, gravity ≥7 → resistance_probe.

Automated regression (local/staging):

```bash
cd backend && npm test -- --testPathPattern=stage1SessionIntake
cd ai-worker && python -m pytest tests/test_coach_intake.py -q
```

## Phase 1 — Client sign-off

**Before/after samples:** [coach-cert-samples.md](./coach-cert-samples.md)

Sign-off record (fill when complete):

| Field | Value |
|-------|-------|
| Date | |
| Reviewer | |
| Environment | staging |
| Domain tested | income |
| All 5 checklist items | pass / fail |
| Approved for production | yes / no |

Production promotion is a **separate deploy** after sign-off (backend `staging`, frontend `main`, ai-worker `main`).

## Phase 2 — Feature flags (default off)

| Env var | Purpose |
|---------|---------|
| `COACH_CERT_DEEP_ENABLED` | Quantum / NLP / change-history coach path (member copy stays plain) |
| `BRAIN_PROMPT_V2_SHADOW` | Load `Brain Prompt V2` + `coach_v2` from DB |
| `TREATMENT_PLAN_ENABLED` | `POST /api/stage1/treatment-plan/generate` + Domains UI |

Apply Phase 2 DB prompts (shadow rows, inactive in prod until flip):

```bash
cd backend
node src/scripts/applyCoachCertPromptV2.js --dry-run
node src/scripts/applyCoachCertPromptV2.js
```

Enable on staging only after Phase 1 sign-off. Run Income E2E: onboarding → map resistance → treatment plan → daily coach → Green Rep → proof.

## Nathan coordination

When Phase 2 basics are deployed to staging with flags off, notify Nathan so final `Brain Prompt V2` / `coach_v2` text can be pasted into shadow DB rows before `BRAIN_PROMPT_V2_SHADOW=true`.
