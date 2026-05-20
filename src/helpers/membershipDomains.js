/**
 * Maps user.membership (Kajabi) → tier limits for Stage 1 domain_maps.
 */

const TIERS = Object.freeze({
  BRONZE: "bronze",
  SILVER: "silver",
  ACCELERATE: "accelerate",
  STANDARD: "standard",
});

const TIER_LIMITS = Object.freeze({
  [TIERS.BRONZE]: { maxStoredGoals: 3, maxActiveDomains: 1 },
  [TIERS.SILVER]: { maxStoredGoals: Infinity, maxActiveDomains: 2 },
  [TIERS.ACCELERATE]: { maxStoredGoals: Infinity, maxActiveDomains: 5 },
  [TIERS.STANDARD]: { maxStoredGoals: 1, maxActiveDomains: 1 },
});

const getTier = (user) => {
  const m = user?.membership || {};
  if (m.isCreatorClubAccelerate || m.isAccelerate) return TIERS.ACCELERATE;
  if (m.isCreatorClubSilver || m.isSilver) return TIERS.SILVER;
  if (m.isCreatorClubBronze || m.isBronze) return TIERS.BRONZE;
  if (m.isCreatorClub || m.isCreatorClub === true) return TIERS.BRONZE;
  return TIERS.STANDARD;
};

const getTierLimits = (tier) => TIER_LIMITS[tier] || TIER_LIMITS[TIERS.STANDARD];

const maxStoredGoals = (user) => getTierLimits(getTier(user)).maxStoredGoals;

const maxActiveDomains = (user) => getTierLimits(getTier(user)).maxActiveDomains;

/**
 * @param {object} user
 * @param {number} currentStoredCount - domain_maps with a goal started (non-empty)
 * @param {boolean} isUpdate - true when updating existing stored map
 */
const canAddStoredGoal = (user, currentStoredCount, isUpdate = false) => {
  const max = maxStoredGoals(user);
  if (!Number.isFinite(max)) return true;
  if (isUpdate) return true;
  return currentStoredCount < max;
};

/**
 * @param {object} user
 * @param {number} currentActiveCount
 * @param {boolean} domainAlreadyActive
 */
const canActivateDomain = (user, currentActiveCount, domainAlreadyActive = false) => {
  const max = maxActiveDomains(user);
  if (domainAlreadyActive) return true;
  return currentActiveCount < max;
};

module.exports = {
  TIERS,
  TIER_LIMITS,
  getTier,
  getTierLimits,
  maxStoredGoals,
  maxActiveDomains,
  canAddStoredGoal,
  canActivateDomain,
};
