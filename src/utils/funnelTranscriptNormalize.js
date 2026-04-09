/**
 * Normalize funnel Chat.data.transcript rows for REST + Socket restore.
 * Matches OpenAI / Sequelize storage shapes (string, array parts, nested content).
 */

const stripFunnelCompleteTag = (content = "") =>
  String(content).replace(/\s*\[FUNNEL_INTAKE_COMPLETE\]\s*/gi, "").trim();

/** Extract text from one OpenAI-style content part (string, { text }, { type, text }, nested value). */
const textFromContentPart = (part) => {
  if (part == null) return "";
  if (typeof part === "string") return part;
  if (typeof part === "object") {
    if (typeof part.text === "string") return part.text;
    if (part.text && typeof part.text === "object" && typeof part.text.value === "string") {
      return part.text.value;
    }
    if (typeof part.content === "string") return part.content;
    if (Array.isArray(part.content)) return part.content.map(textFromContentPart).join("");
    if (part.type === "text" && part.text != null) return textFromContentPart(part.text);
  }
  return "";
};

/**
 * DB may store transcript as JSON array, stringified JSON, or under alternate keys.
 */
const coerceFunnelTranscriptRaw = (raw) => {
  if (raw == null) return [];
  if (typeof raw === "string") {
    const t = raw.trim();
    if (!t) return [];
    try {
      return coerceFunnelTranscriptRaw(JSON.parse(t));
    } catch {
      return [];
    }
  }
  if (Array.isArray(raw)) return raw;
  if (typeof raw === "object") {
    if (Array.isArray(raw.transcript)) return raw.transcript;
    if (Array.isArray(raw.messages)) return raw.messages;
    if (Array.isArray(raw.items)) return raw.items;
    if (Array.isArray(raw.history)) return raw.history;
  }
  return [];
};

/**
 * Pull a message array from Chat.data wherever it may live (legacy / nested shapes).
 */
const collectFunnelTranscriptRawFromData = (data) => {
  if (!data || typeof data !== "object") return [];
  const candidates = [
    data.transcript,
    data.messages,
    data.discoveryChatTranscript,
    data.intakeTranscript,
    data.intakeState?.transcript,
    data.intakeState?.messages,
  ];
  for (const c of candidates) {
    const arr = coerceFunnelTranscriptRaw(c);
    if (arr.length > 0) return arr;
  }
  const t = data.transcript;
  if (t && typeof t === "object" && !Array.isArray(t)) {
    for (const key of ["messages", "items", "history"]) {
      const arr = coerceFunnelTranscriptRaw(t[key]);
      if (arr.length > 0) return arr;
    }
  }
  return [];
};

const looseNormalizeRow = (m) => {
  if (!m || typeof m !== "object") return null;
  let role = normalizeFunnelStoredRole(m);
  if (!role) {
    const r = String(m.role || m.sender || m.from || "").toLowerCase();
    if (/(assistant|^ai$|bot|model)/.test(r)) role = "assistant";
    else if (/(^user$|human|client)/.test(r)) role = "user";
  }
  let content = normalizeFunnelStoredContent(m);
  if (!content && typeof m.refusal === "string") content = m.refusal.trim();
  if (!content && m.content && typeof m.content === "object" && typeof m.content.refusal === "string") {
    content = m.content.refusal.trim();
  }
  if (!content && typeof m.value === "string") content = m.value.trim();
  if (!role || !content) return null;
  content = stripFunnelCompleteTag(content);
  if (!content) return null;
  return { role, content };
};

/**
 * Full Chat.data → normalized transcript for API + socket restore.
 * Uses strict normalization first; if everything was dropped (shape mismatch), tries loose extraction.
 */
const normalizeFunnelTranscriptRowsFromChatData = (data) => {
  const raw = collectFunnelTranscriptRawFromData(data);
  if (raw.length === 0) return [];
  const strict = normalizeFunnelTranscriptRows(raw);
  if (strict.length > 0) return strict;
  const loose = [];
  for (const m of raw) {
    const row = looseNormalizeRow(m);
    if (row) loose.push(row);
  }
  return loose;
};

const normalizeFunnelStoredRole = (m) => {
  const r = String(m?.role || "").toLowerCase();
  if (r === "assistant" || r === "model") return "assistant";
  if (r === "user") return "user";
  return null;
};

const normalizeFunnelStoredContent = (m) => {
  if (!m) return "";
  if (m.content == null) {
    if (typeof m.text === "string") return m.text.trim();
    if (typeof m.message === "string") return m.message.trim();
    return "";
  }
  const c = m.content;
  if (typeof c === "string") return c.trim();
  if (Array.isArray(c)) {
    return c.map(textFromContentPart).join("").trim();
  }
  if (typeof c === "object") {
    if (typeof c.content === "string") return String(c.content).trim();
    if (Array.isArray(c.content)) return c.content.map(textFromContentPart).join("").trim();
    const nested = textFromContentPart(c);
    if (nested) return nested.trim();
  }
  return String(c).trim();
};

/**
 * Map raw DB transcript rows to { role, content }[] suitable for clients and restore.
 */
const normalizeFunnelTranscriptRows = (raw) => {
  raw = coerceFunnelTranscriptRaw(raw);
  if (!Array.isArray(raw) || raw.length === 0) return [];
  const rows = [];
  for (const m of raw) {
    const role = normalizeFunnelStoredRole(m);
    let content = normalizeFunnelStoredContent(m);
    if (!role || !content) continue;
    content = stripFunnelCompleteTag(content);
    if (!content) continue;
    rows.push({ role, content });
  }
  return rows;
};

/**
 * Persist-only: coerce in-memory socket messages to plain { role, content } strings for JSONB.
 */
const flattenTranscriptMessagesForPersist = (transcript) => {
  if (!Array.isArray(transcript)) return [];
  const out = [];
  for (const m of transcript) {
    const role = normalizeFunnelStoredRole(m);
    if (role !== "assistant" && role !== "user") continue;
    let content = normalizeFunnelStoredContent(m);
    if (!content && typeof m.refusal === "string") content = m.refusal.trim();
    if (!content) continue;
    content = stripFunnelCompleteTag(content);
    if (!content) continue;
    out.push({ role, content });
  }
  return out;
};

module.exports = {
  stripFunnelCompleteTag,
  coerceFunnelTranscriptRaw,
  collectFunnelTranscriptRawFromData,
  normalizeFunnelStoredRole,
  normalizeFunnelStoredContent,
  normalizeFunnelTranscriptRows,
  normalizeFunnelTranscriptRowsFromChatData,
  flattenTranscriptMessagesForPersist,
};
