const { DOMAIN_LABELS } = require("../constants/domains");

const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

const newSessionId = () =>
  `coach-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

/**
 * Append a coach check-in to structured session log (grouped by domain + 4h window).
 */
const recordCoachCheckin = (stage1, payload) => {
  const {
    domain,
    state,
    messages = [],
    user_message,
    assistant_message,
    green_rep,
    gravity_rating,
  } = payload;

  const sessions = Array.isArray(stage1.coach_session_log)
    ? [...stage1.coach_session_log]
    : [];
  const now = new Date().toISOString();
  const nowMs = Date.now();

  let current = sessions.length ? sessions[sessions.length - 1] : null;
  const lastMs = current?.updated_at ? new Date(current.updated_at).getTime() : 0;
  const gap = nowMs - lastMs;

  if (!current || current.domain !== domain || gap > SESSION_GAP_MS) {
    current = {
      id: newSessionId(),
      domain,
      state_at_start: state,
      state_last: state,
      started_at: now,
      updated_at: now,
      gravity_rating_last: gravity_rating ?? null,
      messages: [],
      turn_count: 0,
    };
    sessions.push(current);
  }

  if (Array.isArray(messages) && messages.length > 0) {
    current.messages = messages
      .filter((m) => m?.role && m?.content)
      .map((m) => ({ role: m.role, content: String(m.content) }));
  } else {
    if (user_message?.trim()) {
      current.messages.push({ role: "user", content: user_message.trim() });
    }
    if (assistant_message?.trim()) {
      current.messages.push({
        role: "assistant",
        content: assistant_message.trim(),
      });
    }
  }

  current.updated_at = now;
  current.state_last = state;
  current.turn_count = (current.turn_count || 0) + 1;
  if (green_rep) current.green_rep_last = green_rep;
  if (gravity_rating != null) current.gravity_rating_last = gravity_rating;

  return {
    ...stage1,
    coach_session_log: sessions.slice(-40),
  };
};

/** Build sessions list from coach_session_log + legacy coach_sessions turns. */
const listCoachHistory = (stage1, { domain = null } = {}) => {
  let sessions = Array.isArray(stage1.coach_session_log)
    ? [...stage1.coach_session_log]
    : [];

  if (!sessions.length && Array.isArray(stage1.coach_sessions)) {
    sessions = migrateLegacyCoachSessions(stage1.coach_sessions);
  }

  let filtered = sessions;
  if (domain) {
    filtered = sessions.filter((s) => s.domain === domain);
  }

  return filtered
    .slice()
    .reverse()
    .map((s) => {
      const msgs = Array.isArray(s.messages) ? s.messages : [];
      const firstUser = msgs.find((m) => m.role === "user");
      const lastAssistant = [...msgs].reverse().find((m) => m.role === "assistant");
      return {
        id: s.id,
        domain: s.domain,
        domain_label: DOMAIN_LABELS[s.domain] || s.domain,
        state_at_start: s.state_at_start,
        state_last: s.state_last,
        started_at: s.started_at,
        updated_at: s.updated_at,
        turn_count: s.turn_count || msgs.filter((m) => m.role === "user").length,
        message_count: msgs.length,
        messages: msgs,
        preview:
          firstUser?.content?.slice(0, 120) ||
          lastAssistant?.content?.slice(0, 120) ||
          "",
        green_rep_last: s.green_rep_last || null,
      };
    });
};

const migrateLegacyCoachSessions = (turns) => {
  const byDayDomain = new Map();
  for (const t of turns) {
    if (!t?.at || !t?.domain) continue;
    const day = t.at.slice(0, 10);
    const key = `${t.domain}:${day}`;
    if (!byDayDomain.has(key)) {
      byDayDomain.set(key, {
        id: newSessionId(),
        domain: t.domain,
        state_at_start: t.state || "clear",
        state_last: t.state || "clear",
        started_at: t.at,
        updated_at: t.at,
        messages: [],
        turn_count: 0,
      });
    }
    const sess = byDayDomain.get(key);
    if (t.user_message) {
      sess.messages.push({ role: "user", content: String(t.user_message) });
    }
    if (t.assistant_message) {
      sess.messages.push({
        role: "assistant",
        content: String(t.assistant_message),
      });
    }
    sess.updated_at = t.at;
    sess.state_last = t.state || sess.state_last;
    sess.turn_count += 1;
    if (t.green_rep) sess.green_rep_last = t.green_rep;
  }
  return [...byDayDomain.values()].sort(
    (a, b) => new Date(a.started_at) - new Date(b.started_at),
  );
};

/** Resume messages from the latest open session for a domain (within gap). */
const getResumableCoachMessages = (stage1, domain) => {
  const sessions = Array.isArray(stage1.coach_session_log)
    ? stage1.coach_session_log
    : [];
  if (!sessions.length) return [];
  const last = sessions[sessions.length - 1];
  if (last.domain !== domain) return [];
  const gap = Date.now() - new Date(last.updated_at || last.started_at).getTime();
  if (gap > SESSION_GAP_MS) return [];
  return Array.isArray(last.messages) ? last.messages : [];
};

module.exports = {
  recordCoachCheckin,
  listCoachHistory,
  getResumableCoachMessages,
  SESSION_GAP_MS,
};
