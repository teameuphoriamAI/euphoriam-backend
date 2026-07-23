const {
  resolveSessionIntakeFlow,
  buildIntentionOpening,
  SESSION_PHASES,
  detectFeltSensation,
} = require("../stage1/coach/flows/sessionIntake");

describe("stage1SessionIntake", () => {
  test("buildIntentionOpening asks for session intention", () => {
    const msg = buildIntentionOpening({
      firstName: "Teresa",
      goalPhrase: "reduce pressure at work",
    });
    expect(msg).toMatch(/Teresa/i);
    expect(msg).toMatch(/what do you want from this session/i);
    expect(msg).toMatch(/confidential/i);
    expect(msg).not.toMatch(/vortex|signature|quantum/i);
  });

  test("no intention → intention phase", () => {
    const flow = resolveSessionIntakeFlow({
      openSession: { session_intake: {} },
      userMessage: "",
      reqBody: {},
      messages: [],
      gravityRating: 4,
    });
    expect(flow.session_phase).toBe(SESSION_PHASES.INTENTION);
    expect(flow.awaiting_session_intention).toBe(true);
  });

  test("intention set → emotional check-in when no sensation", () => {
    const flow = resolveSessionIntakeFlow({
      openSession: { session_intake: {} },
      userMessage: "I want clarity on my next step at work",
      reqBody: { session_intention: "I want clarity on my next step at work" },
      messages: [{ role: "user", content: "I want clarity on my next step at work" }],
      gravityRating: 5,
    });
    expect(flow.session_intention).toContain("clarity");
    expect(flow.session_phase).toBe(SESSION_PHASES.EMOTIONAL_CHECKIN);
    expect(flow.awaiting_emotional_checkin).toBe(true);
  });

  test("resistance keywords → resistance_probe", () => {
    const flow = resolveSessionIntakeFlow({
      openSession: {
        session_intake: {
          session_intention: "Feel less stuck",
          emotional_checkin_complete: true,
        },
      },
      userMessage: "My head feels like it's in a vice — totally overwhelmed",
      reqBody: {},
      messages: [
        { role: "user", content: "Feel less stuck" },
        { role: "assistant", content: "Got it." },
      ],
      gravityRating: 6,
    });
    expect(flow.session_phase).toBe(SESSION_PHASES.RESISTANCE_PROBE);
  });

  test("high gravity → resistance_probe", () => {
    const flow = resolveSessionIntakeFlow({
      openSession: {
        session_intake: {
          session_intention: "Calm down",
          emotional_checkin_skipped: true,
        },
      },
      userMessage: "Still hard",
      reqBody: {},
      messages: [],
      gravityRating: 8,
    });
    expect(flow.session_phase).toBe(SESSION_PHASES.RESISTANCE_PROBE);
  });

  test("detectFeltSensation finds body language", () => {
    expect(
      detectFeltSensation("I feel pressure in my solar plexus when I think about work"),
    ).toMatch(/solar plexus/i);
    expect(detectFeltSensation("ok")).toBeNull();
  });

  test("same-day session skips re-intention when intention already set", () => {
    const recentStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const flow = resolveSessionIntakeFlow({
      openSession: {
        started_at: recentStart,
        session_intake: {
          session_intention: "Finish the proposal",
          emotional_checkin_complete: true,
        },
      },
      userMessage: "Finish the proposal",
      reqBody: { session_intention: "Finish the proposal" },
      messages: [{ role: "user", content: "Finish the proposal" }],
      gravityRating: 4,
    });
    expect(flow.session_phase).toBe(SESSION_PHASES.EXPLORE);
  });

  test("yes-man language sets yes_man_pattern", () => {
    const flow = resolveSessionIntakeFlow({
      openSession: {
        session_intake: {
          session_intention: "Set boundaries",
          emotional_checkin_complete: true,
        },
      },
      userMessage: "I'm such a yes-man with my mother — I can't say no",
      reqBody: {},
      messages: [],
      gravityRating: 5,
    });
    expect(flow.yes_man_pattern).toBe(true);
  });

  test("skip emotional check-in when user opts out", () => {
    const flow = resolveSessionIntakeFlow({
      openSession: {
        session_intake: { session_intention: "Move forward" },
      },
      userMessage: "Let's coach — skip the body stuff",
      reqBody: {},
      messages: [{ role: "user", content: "Move forward" }],
      gravityRating: 4,
    });
    expect(flow.session_intake_update.emotional_checkin_skipped).toBe(true);
  });

  test("cert deep enabled → deep_probe when user asks to go deeper", () => {
    const flow = resolveSessionIntakeFlow({
      openSession: {
        session_intake: {
          session_intention: "Break the freeze",
          emotional_checkin_complete: true,
        },
      },
      userMessage: "I'm ready to go deeper on this pattern",
      reqBody: {},
      messages: [],
      gravityRating: 5,
      certDeepEnabled: true,
    });
    expect(flow.session_phase).toBe(SESSION_PHASES.DEEP_PROBE);
    expect(flow.deep_probe_active).toBe(true);
    expect(flow.cert_deep_enabled).toBe(true);
  });

  test("force_new_session bypasses same-day skipReIntention", () => {
    const recentStart = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    const skipped = resolveSessionIntakeFlow({
      openSession: {
        started_at: recentStart,
        session_intake: {
          session_intention: "Finish the proposal",
          emotional_checkin_complete: true,
        },
      },
      userMessage: "Continue working",
      reqBody: { session_intention: "Finish the proposal" },
      messages: [{ role: "user", content: "Continue working" }],
      gravityRating: 4,
    });
    const forced = resolveSessionIntakeFlow({
      openSession: {
        started_at: recentStart,
        session_intake: {},
      },
      userMessage: "",
      reqBody: { force_new_session: true },
      messages: [],
      gravityRating: 4,
    });
    expect(skipped.session_phase).toBe(SESSION_PHASES.EXPLORE);
    expect(forced.session_phase).toBe(SESSION_PHASES.INTENTION);
  });

  test("body_echo_required when felt sensation in resistance_probe", () => {
    const flow = resolveSessionIntakeFlow({
      openSession: {
        session_intake: {
          session_intention: "Feel less stuck",
          emotional_checkin_complete: true,
          felt_sensation: "Tight chest and solar plexus",
        },
      },
      userMessage: "My head feels like it's in a vice",
      reqBody: {},
      messages: [],
      gravityRating: 7,
    });
    expect(flow.body_echo_required).toBe(true);
    expect(flow.smallest_step_mode).toBe(true);
  });

  test("insight_integration after resistance resolves", () => {
    const flow = resolveSessionIntakeFlow({
      openSession: {
        session_intake: {
          session_intention: "Set boundaries",
          emotional_checkin_complete: true,
          resistance_probe_active: true,
        },
      },
      userMessage: "I see it now — I say yes to stay safe from conflict",
      reqBody: {},
      messages: [
        { role: "user", content: "Set boundaries" },
        { role: "assistant", content: "What feels heaviest?" },
        { role: "user", content: "Pressure in my chest" },
      ],
      gravityRating: 6,
    });
    expect(flow.session_phase).toBe(SESSION_PHASES.INSIGHT_INTEGRATION);
  });
});
