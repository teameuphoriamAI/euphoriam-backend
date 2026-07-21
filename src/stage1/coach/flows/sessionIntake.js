/**
 * Certification-aligned session intake phases (app-friendly).
 * intention → emotional_checkin (optional) → explore | resistance_probe
 */

const RESISTANCE_SIGNAL =
  /\b(stuck|overwhelm|overwhelmed|pressure|vice|exhaust|exhausted|can't cope|cannot cope|avoid|avoiding|freeze|frozen|shutdown|numb|anxious|anxiety|panic|tight|chest|solar plexus|headache|tension)\b/i;

const BODY_SIGNAL =
  /\b(feel it in|feels in|tight|tension|pressure|chest|stomach|gut|solar plexus|neck|shoulders|head|body|physically|sensation)\b/i;

const SKIP_EMOTIONAL =
  /\b(skip|not sure|don't know|dont know|rather not|move on|let's coach|lets coach|just coach)\b/i;

const YES_MAN_SIGNAL =
  /\b(yes[\s-]?man|people[\s-]?pleas|say yes|always say yes|can't say no|cannot say no|mother|mum|mom)\b/i;

const SESSION_GAP_MS = 4 * 60 * 60 * 1000;

const SESSION_PHASES = Object.freeze({
  INTENTION: "intention",
  EMOTIONAL_CHECKIN: "emotional_checkin",
  EXPLORE: "explore",
  RESISTANCE_PROBE: "resistance_probe",
  DEEP_PROBE: "deep_probe",
  INTEGRATION: "integration",
  INTEGRATION_DEEP: "integration_deep",
});

const DEEP_READY_SIGNAL =
  /\b(go deeper|ready to go deeper|let's go deeper|lets go deeper|take me deeper|deeper work)\b/i;

const CHANGE_HISTORY_SIGNAL =
  /\b(always been this way|since i was|childhood|young|pattern started|been like this|years ago)\b/i;

const readIntake = (openSession) => {
  const raw = openSession?.session_intake;
  return raw && typeof raw === "object" ? { ...raw } : {};
};

/** @param {object} reqBody */
const proofCycleIntegrationHint = (reqBody) =>
  Boolean(reqBody?.proof_integration_mode || reqBody?.session_phase === "integration");

const detectFeltSensation = (text) => {
  const t = String(text || "").trim();
  if (!t || t.length < 8) return null;
  if (!BODY_SIGNAL.test(t) && !RESISTANCE_SIGNAL.test(t)) return null;
  return t.length > 280 ? `${t.slice(0, 277)}...` : t;
};

/**
 * @param {object} params
 * @param {object|null} params.openSession
 * @param {string} params.userMessage
 * @param {object} params.reqBody
 * @param {Array} params.messages
 * @param {number|null} params.gravityRating
 * @param {boolean} [params.certDeepEnabled=false]
 */
const resolveSessionIntakeFlow = ({
  openSession,
  userMessage,
  reqBody = {},
  messages = [],
  gravityRating = null,
  certDeepEnabled = false,
}) => {
  const intake = readIntake(openSession);
  const userTurns =
    (Array.isArray(messages) ? messages.filter((m) => m?.role === "user").length : 0) +
    (userMessage?.trim() ? 1 : 0);

  let sessionIntention =
    String(reqBody.session_intention || intake.session_intention || "").trim() || null;
  let feltSensation =
    String(reqBody.felt_sensation || intake.felt_sensation || "").trim() || null;

  const frictionContext =
    reqBody.friction_context && typeof reqBody.friction_context === "object"
      ? reqBody.friction_context
      : intake.friction_context || null;

  if (!sessionIntention && userMessage?.trim() && userTurns <= 1) {
    const msg = userMessage.trim();
    if (msg.length >= 12 && !RESISTANCE_SIGNAL.test(msg)) {
      sessionIntention = msg;
    }
  }

  if (!feltSensation && userMessage?.trim()) {
    feltSensation = detectFeltSensation(userMessage);
  }

  const sessionStartedAt = openSession?.started_at
    ? new Date(openSession.started_at).getTime()
    : null;
  const sameDaySession =
    sessionStartedAt != null &&
    Number.isFinite(sessionStartedAt) &&
    Date.now() - sessionStartedAt < SESSION_GAP_MS;
  const skipReIntention = Boolean(
    sameDaySession && intake.session_intention && sessionIntention,
  );

  let sessionPhase = SESSION_PHASES.EXPLORE;
  let awaitingSessionIntention = false;
  let awaitingEmotionalCheckin = false;
  let stopDiscovery = false;

  if (!sessionIntention) {
    sessionPhase = SESSION_PHASES.INTENTION;
    awaitingSessionIntention = true;
    stopDiscovery = false;
  } else if (skipReIntention) {
    sessionPhase = SESSION_PHASES.EXPLORE;
  } else if (
    !intake.emotional_checkin_complete &&
    !intake.emotional_checkin_skipped &&
    !feltSensation &&
    userTurns <= 2 &&
    !SKIP_EMOTIONAL.test(userMessage || "")
  ) {
    sessionPhase = SESSION_PHASES.EMOTIONAL_CHECKIN;
    awaitingEmotionalCheckin = true;
    stopDiscovery = false;
  } else if (
    RESISTANCE_SIGNAL.test(userMessage || "") ||
    (gravityRating != null && Number(gravityRating) >= 7)
  ) {
    sessionPhase = SESSION_PHASES.RESISTANCE_PROBE;
  }

  let deep_probe_active = false;
  let change_history_hook = null;

  if (certDeepEnabled && sessionIntention && !awaitingSessionIntention && !awaitingEmotionalCheckin) {
    if (DEEP_READY_SIGNAL.test(userMessage || "") || intake.deep_probe_active) {
      sessionPhase = SESSION_PHASES.DEEP_PROBE;
      deep_probe_active = true;
      stopDiscovery = true;
    }
    if (CHANGE_HISTORY_SIGNAL.test(userMessage || "")) {
      change_history_hook = String(userMessage || "").trim().slice(0, 500) || null;
    }
    if (
      intake.deep_probe_complete &&
      (proofCycleIntegrationHint(reqBody) || /\b(integrat|takeaway|what i learned)\b/i.test(userMessage || ""))
    ) {
      sessionPhase = SESSION_PHASES.INTEGRATION_DEEP;
    }
  }

  const intakeUpdate = {
    session_intention: sessionIntention,
    felt_sensation: feltSensation,
    friction_context: frictionContext,
    emotional_checkin_complete: Boolean(
      intake.emotional_checkin_complete ||
        feltSensation ||
        intake.emotional_checkin_skipped,
    ),
    emotional_checkin_skipped: Boolean(
      intake.emotional_checkin_skipped || SKIP_EMOTIONAL.test(userMessage || ""),
    ),
    friction_acknowledged: Boolean(intake.friction_acknowledged || frictionContext),
    deep_probe_active: deep_probe_active || Boolean(intake.deep_probe_active),
    deep_probe_complete: Boolean(intake.deep_probe_complete),
    change_history_hook: change_history_hook || intake.change_history_hook || null,
  };

  if (awaitingEmotionalCheckin && feltSensation) {
    intakeUpdate.emotional_checkin_complete = true;
    sessionPhase = SESSION_PHASES.EXPLORE;
    awaitingEmotionalCheckin = false;
  }

  return {
    session_phase: sessionPhase,
    session_intention: sessionIntention,
    felt_sensation: feltSensation,
    friction_context: frictionContext,
    awaiting_session_intention: awaitingSessionIntention,
    awaiting_emotional_checkin: awaitingEmotionalCheckin,
    stop_discovery: stopDiscovery,
    yes_man_pattern: YES_MAN_SIGNAL.test(userMessage || ""),
    cert_deep_enabled: Boolean(certDeepEnabled),
    deep_probe_active,
    change_history_hook: change_history_hook || intake.change_history_hook || null,
    session_intake_update: intakeUpdate,
  };
};

const buildIntentionOpening = ({ firstName, goalPhrase }) => {
  const name = firstName?.trim() || "there";
  return [
    `Hey ${name}.`,
    "",
    "Everything you share here is confidential — this is your space to be honest.",
    "",
    goalPhrase ? `We're working on ${goalPhrase}.` : "Good to see you.",
    "",
    "What brought you here today — and **what do you want from this session?**",
    "",
    "Is it okay if we focus on that together? One sentence is enough.",
  ].join("\n");
};

module.exports = {
  SESSION_PHASES,
  resolveSessionIntakeFlow,
  buildIntentionOpening,
  detectFeltSensation,
};
