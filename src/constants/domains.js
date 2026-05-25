/** Five Stage 1 life domains — keep in sync with euphoriam-frontend/src/lib/constants.ts */

const DOMAINS = Object.freeze([
  "income",
  "alignment",
  "relationships",
  "health",
  "wealth",
]);

const DOMAIN_LABELS = Object.freeze({
  income: "Income",
  alignment: "Alignment",
  relationships: "Relationships",
  health: "Health",
  wealth: "Wealth",
});

const DOMAIN_SET = new Set(DOMAINS);

const normalizeDomain = (value) => {
  if (value == null || value === "") return null;
  const key = String(value).trim().toLowerCase();
  return DOMAIN_SET.has(key) ? key : null;
};

const isValidDomain = (value) => normalizeDomain(value) !== null;

module.exports = {
  DOMAINS,
  DOMAIN_LABELS,
  DOMAIN_SET,
  normalizeDomain,
  isValidDomain,
};
