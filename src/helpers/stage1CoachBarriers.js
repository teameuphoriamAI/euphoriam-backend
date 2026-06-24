/**
 * Persistent member barriers — survive new coach sessions (chat resets, memory does not).
 */

const { detectNoTrustedPerson, NO_TRUSTED_PERSON_PATTERN } = require("./stage1CoachConversationSignals");
const { ensureCoachingMemory } = require("./stage1CoachingMemory");

const PERSON_PROOF_PATTERN =
  /\b(someone\s+i\s+trust|someone\s+you\s+trust|trusted\s+person|reach\s+out\s+to|tell\s+them|send\s+to\s+someone)\b/i;

const coachLogUserTexts = (stage1, domain) => {
  const sessions = Array.isArray(stage1?.coach_session_log) ? stage1.coach_session_log : [];
  const texts = [];
  for (const sess of sessions) {
    if (domain && sess.domain !== domain) continue;
    for (const m of sess.messages || []) {
      if (m?.role === "user" && String(m.content || "").trim()) {
        texts.push(String(m.content).trim());
      }
    }
  }
  return texts;
};

const readStoredBarriers = (map) => {
  const memory = ensureCoachingMemory(map);
  const raw = memory.member_barriers;
  if (!raw || typeof raw !== "object") return {};
  return {
    no_trusted_person: Boolean(raw.no_trusted_person),
    noted_at: raw.noted_at || null,
    source: raw.source || null,
  };
};

/**
 * Barriers from stored memory + all prior coach chats + current session.
 */
const resolvePersistentBarriers = ({
  map = null,
  stage1 = null,
  domain = null,
  messages = [],
  userMessage = "",
} = {}) => {
  const stored = readStoredBarriers(map);
  const historyTexts = coachLogUserTexts(stage1, domain);
  const currentTexts = (messages || [])
    .filter((m) => m?.role === "user")
    .map((m) => String(m.content || "").trim())
    .filter(Boolean);
  const allTexts = [...historyTexts, ...currentTexts, String(userMessage || "").trim()].filter(
    Boolean,
  );

  const no_trusted_person =
    stored.no_trusted_person || detectNoTrustedPerson(allTexts);

  return {
    no_trusted_person,
    stored_no_trusted_person: stored.no_trusted_person,
    source: stored.no_trusted_person ? stored.source || "memory" : no_trusted_person ? "transcript" : null,
  };
};

const mergeBarriersIntoMemory = (map, barriers) => {
  if (!barriers?.no_trusted_person) return map;
  const memory = ensureCoachingMemory(map);
  return {
    ...map,
    coaching_memory: {
      ...memory,
      member_barriers: {
        no_trusted_person: true,
        noted_at: memory.member_barriers?.noted_at || new Date().toISOString(),
        source: memory.member_barriers?.source || barriers.source || "coach_chat",
      },
    },
  };
};

/** Proof lines can be intentions/rep labels — not evidence the member has someone to talk to. */
const annotateProofsForCoach = (proofs = [], barriers = {}) => {
  return (proofs || []).map((p) => {
    const action = String(p.action || p.type || "").trim();
    const looksLikePersonRep = PERSON_PROOF_PATTERN.test(action);
    if (barriers.no_trusted_person && looksLikePersonRep) {
      return {
        ...p,
        coach_note:
          "Logged rep label or intention — NOT confirmed that member has someone to talk to. Do not cite as completed social proof.",
      };
    }
    return p;
  });
};

module.exports = {
  NO_TRUSTED_PERSON_PATTERN,
  PERSON_PROOF_PATTERN,
  coachLogUserTexts,
  resolvePersistentBarriers,
  mergeBarriersIntoMemory,
  annotateProofsForCoach,
};
