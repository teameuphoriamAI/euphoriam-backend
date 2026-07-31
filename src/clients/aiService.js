const axios = require("axios");
const crypto = require("crypto");

const BASE = (process.env.AI_SERVICE_URL || "").replace(/\/$/, "");
const TIMEOUT_MS = Number(process.env.AI_SERVICE_TIMEOUT_MS || 120000);
const INTERNAL_KEY = process.env.AI_SERVICE_INTERNAL_KEY || "";

const flags = {
  coach: process.env.USE_PYTHON_COACH === "true",
  mapResistance: process.env.USE_PYTHON_MAP_RESISTANCE === "true",
};

const { stage1FeatureFlags } = require("../helpers/stage1FeatureFlags");

/** Keys already uploaded to the ai-worker prompt cache this process lifetime. */
const uploadedPromptKeys = new Set();

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

const hashStaticPrompts = (staticPrompts) =>
  crypto.createHash("sha256").update(JSON.stringify(staticPrompts)).digest("hex").slice(0, 32);

/**
 * Split static prompt bundle (cacheable) from per-turn RAG chunks.
 * After the first successful upload of a key, subsequent turns send cache_key + thin overlay.
 */
const prepareCoachPayload = (payload) => {
  const feature_flags = payload.feature_flags || stage1FeatureFlags();
  const prompts = payload.prompts;
  if (!prompts || typeof prompts !== "object") {
    return { wire: { ...payload, feature_flags }, meta: null };
  }

  const ragChunks = prompts.brain_prompt_rag_chunks;
  const staticPrompts = { ...prompts };
  delete staticPrompts.brain_prompt_rag_chunks;
  const key = hashStaticPrompts(staticPrompts);
  const thin = uploadedPromptKeys.has(key);

  const wire = {
    ...payload,
    feature_flags,
    prompts_cache_key: key,
  };

  if (thin) {
    wire.prompts = Array.isArray(ragChunks) && ragChunks.length
      ? { brain_prompt_rag_chunks: ragChunks }
      : null;
  } else {
    wire.prompts =
      Array.isArray(ragChunks) && ragChunks.length
        ? { ...staticPrompts, brain_prompt_rag_chunks: ragChunks }
        : staticPrompts;
  }

  return {
    wire,
    meta: { key, staticPrompts, ragChunks },
  };
};

const fullPromptsBody = (meta) => {
  if (!meta) return null;
  const { staticPrompts, ragChunks } = meta;
  return Array.isArray(ragChunks) && ragChunks.length
    ? { ...staticPrompts, brain_prompt_rag_chunks: ragChunks }
    : staticPrompts;
};

const coachReply = async (payload) => {
  const { wire, meta } = prepareCoachPayload(payload);
  try {
    const data = await post("/v1/coach/reply", wire);
    if (meta?.key) uploadedPromptKeys.add(meta.key);
    return data;
  } catch (err) {
    if (err.status === 428 && meta?.key) {
      uploadedPromptKeys.delete(meta.key);
      const data = await post("/v1/coach/reply", {
        ...wire,
        prompts_cache_key: meta.key,
        prompts: fullPromptsBody(meta),
      });
      uploadedPromptKeys.add(meta.key);
      return data;
    }
    throw err;
  }
};

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

  const openStream = async (body) => {
    try {
      return await axios.post(`${BASE}/v1/coach/reply/stream`, body, {
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
  };

  let { wire, meta } = prepareCoachPayload(payload);
  let response;
  try {
    response = await openStream(wire);
    if (meta?.key) uploadedPromptKeys.add(meta.key);
  } catch (err) {
    if (err.status === 428 && meta?.key) {
      uploadedPromptKeys.delete(meta.key);
      wire = {
        ...wire,
        prompts_cache_key: meta.key,
        prompts: fullPromptsBody(meta),
      };
      response = await openStream(wire);
      uploadedPromptKeys.add(meta.key);
    } else {
      throw err;
    }
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
