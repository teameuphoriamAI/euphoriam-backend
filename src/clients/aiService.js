const axios = require("axios");

const BASE = (process.env.AI_SERVICE_URL || "").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.AI_SERVICE_TIMEOUT_MS || 120000);
const INTERNAL_KEY = process.env.AI_SERVICE_INTERNAL_KEY || "";

const flags = {
  coach: process.env.USE_PYTHON_COACH === "true",
  mapResistance: process.env.USE_PYTHON_MAP_RESISTANCE === "true",
};

const { stage1FeatureFlags } = require("../helpers/stage1FeatureFlags");

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

const coachReply = (payload) =>
  post("/v1/coach/reply", {
    ...payload,
    feature_flags: payload.feature_flags || stage1FeatureFlags(),
  });

/**
 * Async generator of SSE events from /v1/coach/reply/stream.
 * Yields objects like { type: 'delta'|'status'|'result'|'error', ... }.
 */
async function* coachReplyStream(payload) {
  if (!BASE) {
    const err = new Error("AI_SERVICE_URL is not configured");
    err.status = 503;
    throw err;
  }

  const body = {
    ...payload,
    feature_flags: payload.feature_flags || stage1FeatureFlags(),
  };

  let response;
  try {
    response = await axios.post(`${BASE}/v1/coach/reply/stream`, body, {
      headers: {
        ...headers(),
        Accept: "text/event-stream",
      },
      responseType: "stream",
      timeout: TIMEOUT_MS,
    });
  } catch (err) {
    const status = err.response?.status || 502;
    const message =
      err.response?.data?.detail ||
      err.response?.data?.message ||
      err.message ||
      "AI service stream failed";
    const e = new Error(message);
    e.status = status >= 500 ? 502 : status;
    e.cause = err;
    throw e;
  }

  const stream = response.data;
  let buffer = "";

  const parseBlock = (block) => {
    const lines = block.split(/\r?\n/);
    const dataLines = [];
    for (const line of lines) {
      if (line.startsWith("data:")) {
        dataLines.push(line.slice(5).trimStart());
      }
    }
    if (!dataLines.length) return null;
    const raw = dataLines.join("\n");
    if (!raw || raw === "[DONE]") return null;
    try {
      return JSON.parse(raw);
    } catch {
      return null;
    }
  };

  for await (const chunk of stream) {
    buffer += chunk.toString("utf8");
    let sep;
    while ((sep = buffer.search(/\r?\n\r?\n/)) !== -1) {
      const matchLen = buffer.slice(sep).match(/^\r?\n\r?\n/)?.[0].length || 2;
      const block = buffer.slice(0, sep);
      buffer = buffer.slice(sep + matchLen);
      const event = parseBlock(block);
      if (event) yield event;
    }
  }

  if (buffer.trim()) {
    const event = parseBlock(buffer);
    if (event) yield event;
  }
}

const frictionRescue = (payload) =>
  post("/v1/coach/friction", {
    ...payload,
    feature_flags: payload.feature_flags || stage1FeatureFlags(),
  });

const generateTreatmentPlan = (payload) => post("/v1/treatment-plan/generate", payload);

const mapResistanceTurn = (payload) => post("/v1/map-resistance/turn", payload);

const mapResistanceFinalize = (payload) => post("/v1/map-resistance/finalize", payload);

const extractDomainStructure = (payload) =>
  post("/v1/extraction/domain-structure", payload);

module.exports = {
  flags,
  isEnabled,
  coachReply,
  coachReplyStream,
  frictionRescue,
  mapResistanceTurn,
  mapResistanceFinalize,
  extractDomainStructure,
  generateTreatmentPlan,
};
