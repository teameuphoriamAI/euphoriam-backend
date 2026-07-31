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
  [TIERS.BRONZE]: { maxStoredGoals: 3, maxActiveDomains: 1 },
  [TIERS.SILVER]: { maxStoredGoals: Infinity, maxActiveDomains: 2 },
  [TIERS.ACCELERATE]: { maxStoredGoals: Infinity, maxActiveDomains: 5 },
  [TIERS.STANDARD]: { maxStoredGoals: 1, maxActiveDomains: 1 },
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
  return items.map((item) =>
    String(item.title || item.name || "").toLowerCase(),
  );
};

/** Resolve paid tier from users.membership (Kajabi sync) and product titles. */
const getTier = (user) => {
  const { isLocalDevGrantUc } = require("./localDevMembership");
  if (isLocalDevGrantUc()) return TIERS.BRONZE;

  const m = parseMembership(user);
  const titles = productTitles(m);

  if (m.isCreatorClubAccelerate || m.isAccelerate) return TIERS.ACCELERATE;
  if (titles.some((t) => t.includes("accelerate"))) return TIERS.ACCELERATE;
  if (m.isCreatorClubSilver || m.isSilver) return TIERS.SILVER;
  if (m.isCreatorClubBronze || m.isBronze) return TIERS.BRONZE;
  if (m.isCreatorClub || m.isCreatorClub === true) return TIERS.BRONZE;
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
