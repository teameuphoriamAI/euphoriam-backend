#!/usr/bin/env bash
# Open PRs for coach cert upgrade (requires gh CLI).
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/../.." && pwd)"

echo "=== Backend: feature/coach-cert-upgrade-v1 → test ==="
cd "$ROOT/backend"
git push -u origin feature/coach-cert-upgrade-v1 2>/dev/null || git push origin feature/coach-cert-upgrade-v1
gh pr create --base test --head feature/coach-cert-upgrade-v1 \
  --title "Coach certification upgrade (Phase 1 + 2 flags)" \
  --body "Session intake, friction handoff, Phase 2 feature flags, treatment plan API. See docs/COACH-CERT-ROLLOUT.md" \
  || echo "PR may already exist or gh unavailable"

echo "=== Frontend: feature/coach-cert-upgrade-v1 → master ==="
cd "$ROOT/frontend"
git push -u origin feature/coach-cert-upgrade-v1
gh pr create --base master --head feature/coach-cert-upgrade-v1 \
  --title "Coach certification UI + treatment plan card" \
  --body "Intention-led coach, friction banner, Domains treatment plan UI." \
  || echo "PR may already exist or gh unavailable"

echo "=== AI worker: feature/coach-cert-upgrade-v1 → main ==="
cd "$ROOT/ai-worker"
git push -u origin feature/coach-cert-upgrade-v1
gh pr create --base main --head feature/coach-cert-upgrade-v1 \
  --title "Coach cert prompts + Brain V2 engines" \
  --body "Intake/resistance rules, Phase 2 engines, treatment-plan endpoint." \
  || echo "PR may already exist or gh unavailable"

echo "Done. Merge PRs on GitHub, then follow docs/COACH-CERT-ROLLOUT.md"
