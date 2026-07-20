/**
 * Local-only UC access for dev/staging — never enable in production.
 * Set LOCAL_DEV_GRANT_UC=true in backend/.env or docker-compose.
 */
const isLocalDevGrantUc = () =>
  process.env.LOCAL_DEV_GRANT_UC === "true" &&
  process.env.NODE_ENV !== "production";

const LOCAL_DEV_CLUB_STATUS = Object.freeze({
  club: true,
  bronze: true,
  silver: false,
  accelerate: false,
});

const localDevMembershipPayload = () => ({
  isCreatorClub: true,
  isCreatorClubBronze: true,
  isCreatorClubSilver: false,
  isCreatorClubAccelerate: false,
  lastUpdated: new Date().toISOString(),
  products: [{ title: "Creator Club Bronze (local dev)" }],
  offers: [],
});

const localDevDiagnosticContext = () => ({
  products: [{ title: "Creator Club Bronze (local dev)" }],
  offers: [],
});

module.exports = {
  isLocalDevGrantUc,
  LOCAL_DEV_CLUB_STATUS,
  localDevMembershipPayload,
  localDevDiagnosticContext,
};
