const {
  COACH_TURN_MODES,
  resolveCoachTurnMode,
  applyCoachTurnMode,
  isSessionRepLocked,
} = require("../stage1/coach/flows/turnMode");

const map = {
  map_resistance_complete: true,
  protector_rule: "If I follow up, they will think I am pushy",
  core_fear: "Being rejected or ignored",
  failure_strategy: { rule: "Delay follow-ups to stay safe" },
  success_strategy: { behaviour: "Send clear follow-ups" },
  flip_belief: "Visibility is how I get paid",
};

describe("resolveCoachTurnMode", () => {
  test("HOLD when session_rep_locked", () => {
    const mode = resolveCoachTurnMode({
      messages: [
        { role: "assistant", content: 'Today\'s rep is "Start Client Conversation".' },
      ],
      userMessage: "I want the next step for today.",
      map,
      openSession: {
        session_rep_locked: true,
        green_rep_last: { name: "Start Client Conversation" },
      },
      conversationSignals: { mechanism_ready: true, session_wants_next_step: true },
      domain: "income",
    });
    expect(mode.mode).toBe(COACH_TURN_MODES.HOLD);
    expect(mode.assign_green_rep).toBe(false);
    expect(mode.instruction).toMatch(/HOLD/i);
    expect(mode.instruction).not.toMatch(/EDGE\/COST/i);
  });

  test("HOLD when assistant already assigned rep in chat", () => {
    expect(
      isSessionRepLocked(null, [
        { role: "assistant", content: 'Today\'s rep is "Outbound Client Touch".' },
      ]),
    ).toBe(true);
  });

  test("ASSIGN when mechanism ready and wants next step", () => {
    const turns = [];
    for (let i = 0; i < 6; i += 1) {
      turns.push({ role: "user", content: `User turn ${i + 1} about fear of rejection` });
      turns.push({ role: "assistant", content: `What do you notice in your body ${i + 1}?` });
    }
    const userMessage = "I can see the pattern. I want the next step for today.";
    const mode = resolveCoachTurnMode({
      messages: turns,
      userMessage,
      map,
      openSession: null,
      conversationSignals: {
        mechanism_ready: true,
        session_wants_next_step: true,
      },
      domain: "income",
    });
    expect(mode.mode).toBe(COACH_TURN_MODES.ASSIGN);
    expect(mode.assign_green_rep).toBe(true);
    expect(mode.instruction).toMatch(/MECHANISM CLEAR/i);
    expect(mode.allow_solo_fallback).toBe(false);
  });

  test("DISCOVER when mechanism ready but still exploring", () => {
    const mode = resolveCoachTurnMode({
      messages: [
        { role: "user", content: "I avoid follow-ups" },
        { role: "assistant", content: "What do you notice?" },
      ],
      userMessage: "There is a knot in my stomach",
      map,
      conversationSignals: {
        mechanism_ready: true,
        session_wants_next_step: false,
        user_asked_what_next: false,
      },
      domain: "income",
    });
    expect(mode.mode).toBe(COACH_TURN_MODES.DISCOVER);
    expect(mode.assign_green_rep).toBe(false);
  });

  test("INTEGRATE when proof cycle active", () => {
    const mode = resolveCoachTurnMode({
      messages: [],
      userMessage: "I did the rep",
      map,
      conversationSignals: { mechanism_ready: true, session_wants_next_step: true },
      proofCycleFlow: { proof_integration_mode: true },
      domain: "income",
    });
    expect(mode.mode).toBe(COACH_TURN_MODES.INTEGRATE);
    expect(mode.assign_green_rep).toBe(false);
  });

  test("ASSIGN overrides structural blockGreenRep when wants action", () => {
    const turns = [];
    for (let i = 0; i < 6; i += 1) {
      turns.push({ role: "user", content: `Turn ${i + 1} protective part fear rejection` });
      turns.push({ role: "assistant", content: "What do you notice in your body?" });
    }
    const userMessage = "I want the next step for today.";
    const mode = resolveCoachTurnMode({
      messages: turns,
      userMessage,
      map,
      blockGreenRep: true,
      conversationSignals: { mechanism_ready: true },
      domain: "income",
    });
    expect(mode.mode).toBe(COACH_TURN_MODES.ASSIGN);
    expect(mode.assign_green_rep).toBe(true);
    expect(mode.reason).toBe("mechanism_ready_wants_action");
  });

  test("detects what exactly should I do first as wants action", () => {
    const mode = resolveCoachTurnMode({
      messages: [{ role: "user", content: "I avoid follow-ups due to fear" }],
      userMessage: "What exactly should I do first — one message or one call?",
      map,
      conversationSignals: { mechanism_ready: true },
      domain: "income",
    });
    expect(mode.mode).toBe(COACH_TURN_MODES.ASSIGN);
  });

  test("applyCoachTurnMode replaces instruction and assign", () => {
    const transition = {
      coaching_brief: {
        assign_green_rep: true,
        must_assign_green_rep: true,
        instruction: "EDGE/COST: ask before assigning. MECHANISM CLEAR assign now.",
      },
      conversation_signals: {},
    };
    const next = applyCoachTurnMode(transition, {
      mode: COACH_TURN_MODES.HOLD,
      assign_green_rep: false,
      stop_discovery: true,
      discovery_complete: true,
      coaching_mode: "coaching",
      session_rep_locked: true,
      instruction: "HOLD — support existing rep.",
      reason: "session_rep_locked",
    });
    expect(next.coaching_brief.assign_green_rep).toBe(false);
    expect(next.coaching_brief.instruction).toBe("HOLD — support existing rep.");
    expect(next.coaching_brief.instruction).not.toMatch(/EDGE/);
    expect(next.coach_turn_mode).toBe(COACH_TURN_MODES.HOLD);
  });
});
