const axios = require("axios");

const BASE = (process.env.AI_SERVICE_URL || "").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.AI_SERVICE_TIMEOUT_MS || 120000);
const INTERNAL_KEY = process.env.AI_SERVICE_INTERNAL_KEY || "";

const flags = {
  coach: process.env.USE_PYTHON_COACH === "true",
  mapResistance: process.env.USE_PYTHON_MAP_RESISTANCE === "true",
};

const isEnabled = () => Boolean(BASE);

const headers = () => {
  const h = { "Content-Type": "application/json" };
  if (INTERNAL_KEY) h["X-Internal-Key"] = INTERNAL_KEY;
  return h;
};

const post = async (path, body) => {
  if (!BASE) {
    const err = new Error("AI_SERVICE_URL is not configured");
    err.status = 503;
    throw err;
  }
  try {
    const res = await axios.post(`${BASE}${path}`, body, {
      headers: headers(),
      timeout: TIMEOUT_MS,
    });
    return res.data;
  } catch (err) {
    const status = err.response?.status || 502;
    const message =
      err.response?.data?.detail ||
      err.response?.data?.message ||
      err.message ||
      "AI service request failed";
    const e = new Error(message);
    e.status = status >= 500 ? 502 : status;
    e.cause = err;
    throw e;
  }
};

const coachReply = (payload) => post("/v1/coach/reply", payload);

const frictionRescue = (payload) => post("/v1/coach/friction", payload);

const mapResistanceTurn = (payload) => post("/v1/map-resistance/turn", payload);

const mapResistanceFinalize = (payload) => post("/v1/map-resistance/finalize", payload);

const extractDomainStructure = (payload) =>
  post("/v1/extraction/domain-structure", payload);

module.exports = {
  flags,
  isEnabled,
  coachReply,
  frictionRescue,
  mapResistanceTurn,
  mapResistanceFinalize,
  extractDomainStructure,
};
