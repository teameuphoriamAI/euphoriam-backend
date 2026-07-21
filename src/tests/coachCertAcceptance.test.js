/**
 * Coach certification acceptance scenarios — automated guard checks.
 * Full E2E requires staging manual run; see docs/coach-cert-samples.md
 */

const {
  resolveSessionIntakeFlow,
  buildIntentionOpening,
  SESSION_PHASES,
} = require("../stage1/coach/flows/sessionIntake");

describe("coachCertAcceptance", () => {
  test("scenario 1: stuck/pressure → resistance_probe without jargon in opening", () => {
    const opening = buildIntentionOpening({
      firstName: "Teresa",
      goalPhrase: "reduce pressure at work",
    });
    expect(opening).toMatch(/what do you want from this session/i);
    expect(opening).not.toMatch(/how are things going/i);
    expect(opening).not.toMatch(/vortex|quantum|signature/i);

    const flow = resolveSessionIntakeFlow({
      openSession: {
        session_intake: {
          session_intention: "Feel less stuck",
          emotional_checkin_complete: true,
        },
      },
      userMessage: "My head feels like it's in a vice. Work pressure is crushing me.",
      reqBody: {},
      messages: [],
      gravityRating: 7,
    });
    expect(flow.session_phase).toBe(SESSION_PHASES.RESISTANCE_PROBE);
  });

  test("scenario 2: yes-man sets yes_man_pattern", () => {
    const flow = resolveSessionIntakeFlow({
      openSession: {
        session_intake: {
          session_intention: "Help saying no without guilt",
          emotional_checkin_complete: true,
        },
      },
      userMessage: "I said yes again — I'm such a yes-man with my mother",
      reqBody: {},
      messages: [],
      gravityRating: 5,
    });
    expect(flow.yes_man_pattern).toBe(true);
  });

  test("scenario 3: friction_context preserved in intake", () => {
    const friction = { message: "Overwhelm", assistant_message: "Breathe" };
    const flow = resolveSessionIntakeFlow({
      openSession: { session_intake: {} },
      userMessage: "",
      reqBody: { friction_context: friction },
      messages: [],
      gravityRating: 4,
    });
    expect(flow.friction_context).toEqual(friction);
  });

  test("acceptance checklist: intention phase before explore", () => {
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
});
