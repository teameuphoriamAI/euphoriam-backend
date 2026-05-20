/** Fixed life domains — user selects; never free text. */
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

const isValidDomain = (domain) =>
  typeof domain === "string" && DOMAINS.includes(domain.toLowerCase());

const normalizeDomain = (domain) => {
  if (!isValidDomain(domain)) return null;
  return domain.toLowerCase();
};

module.exports = {
  DOMAINS,
  DOMAIN_LABELS,
  isValidDomain,
  normalizeDomain,
};
