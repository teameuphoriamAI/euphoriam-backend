/**
 * Creator Club tier limits for Stage 1 (domains, coach, map resistance).
 * Aligns with euphoriam-frontend/src/lib/membership-limits.ts
 */

const TIERS = Object.freeze({
  STANDARD: "standard",
  BRONZE: "bronze",
  SILVER: "silver",
  ACCELERATE: "accelerate",
});

const TIER_LIMITS = Object.freeze({
  [TIERS.STANDARD]: { maxActiveDomains: 0, maxStoredGoals: 0 },
  [TIERS.BRONZE]: { maxActiveDomains: 1, maxStoredGoals: 3 },
  [TIERS.SILVER]: { maxActiveDomains: 2, maxStoredGoals: Infinity },
  [TIERS.ACCELERATE]: { maxActiveDomains: 5, maxStoredGoals: Infinity },
});

const parseMembership = (user) => {
  let m = user?.membership;
  if (!m) return {};
  if (typeof m === "string") {
    try {
      m = JSON.parse(m);
    } catch {
      return {};
    }
  }
  return typeof m === "object" && m !== null ? m : {};
};

const productTitles = (membership) => {
  const items = [...(membership.products || []), ...(membership.offers || [])];
  return items.map((item) => String(item.title || item.name || "").toLowerCase());
};

/** Resolve paid tier from users.membership (Kajabi sync) and product titles. */
const getTier = (user) => {
  const m = parseMembership(user);
  const titles = productTitles(m);

  if (m.isCreatorClubAccelerate) return TIERS.ACCELERATE;
  if (titles.some((t) => t.includes("accelerate"))) return TIERS.ACCELERATE;
  if (m.isCreatorClubSilver) return TIERS.SILVER;
  if (m.isCreatorClubBronze) return TIERS.BRONZE;
  if (m.isCreatorClub) return TIERS.BRONZE;

  return TIERS.STANDARD;
};

const getTierLimits = (tier) => TIER_LIMITS[tier] || TIER_LIMITS[TIERS.STANDARD];

const canActivateDomain = (user, activeCount, allowOverLimit = false) => {
  if (allowOverLimit) return true;
  const { maxActiveDomains } = getTierLimits(getTier(user));
  return activeCount < maxActiveDomains;
};

const canAddStoredGoal = (user, storedCount, allowOverLimit = false) => {
  if (allowOverLimit) return true;
  const { maxStoredGoals } = getTierLimits(getTier(user));
  if (!Number.isFinite(maxStoredGoals)) return true;
  return storedCount < maxStoredGoals;
};

module.exports = {
  TIERS,
  TIER_LIMITS,
  getTier,
  getTierLimits,
  canActivateDomain,
  canAddStoredGoal,
};
