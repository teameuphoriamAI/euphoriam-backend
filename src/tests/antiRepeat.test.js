const {
  buildAntiRepeatState,
  detectUserRejectsPrescription,
  detectThematicAssistantRepeat,
  detectRepeatedAssistantAdvice,
} = require("../stage1/coach/signals/antiRepeat");
const { buildCoachConversationSignals } = require("../stage1/coach/signals/conversation");
const { resolveCoachingTransition } = require("../stage1/coach/flows/transition");

describe("antiRepeat", () => {
  const transcriptMessages = [
    {
      role: "assistant",
      content:
        "It sounds like fear of rejection. Reach out to someone important today and schedule a catch up.",
    },
    {
      role: "user",
      content:
        "I want to understand why I pull away, not just get something to do.",
    },
    {
      role: "assistant",
      content:
        "This often ties back to fear of rejection or being seen as too much. What thoughts come up?",
    },
    {
      role: "user",
      content:
        "I don't want an exercise. Can we stay with the feeling instead of moving to an action step?",
    },
  ];

  test("detects user rejection of exercises and prescriptions", () => {
    expect(
      detectUserRejectsPrescription([
        "I don't want an exercise. Stay with the feeling instead of another action step.",
      ]),
    ).toBe(true);
  });

  test("detects thematic assistant repeat across transcript", () => {
    expect(detectThematicAssistantRepeat(transcriptMessages)).toBe(true);
    expect(detectRepeatedAssistantAdvice(transcriptMessages)).toBe(true);
  });

  test("buildAntiRepeatState enables discovery_only_mode", () => {
    const state = buildAntiRepeatState({
      messages: transcriptMessages,
      userMessage:
        "I don't want an exercise. Can we stay with the feeling instead of moving to an action step?",
    });
    expect(state.discovery_only_mode).toBe(true);
    expect(state.block_green_rep).toBe(true);
    expect(state.coaching_directive).toMatch(/DISCOVERY ONLY/i);
  });

  test("conversation signals block rep assignment when user rejects exercises", () => {
    const signals = buildCoachConversationSignals({
      messages: transcriptMessages,
      userMessage:
        "I don't want an exercise. Can we stay with the feeling instead of moving to an action step?",
      map: { map_resistance_complete: true },
    });
    expect(signals.discovery_only_mode).toBe(true);
    expect(signals.assign_new_rep).toBe(false);
    expect(signals.user_asked_what_next).toBe(false);
    expect(signals.coaching_directive).toMatch(/DISCOVERY ONLY/i);
  });

  test("transition forces discovery mode when anti-repeat active", () => {
    const transition = resolveCoachingTransition({
      messages: transcriptMessages,
      userMessage:
        "I don't want an exercise. Can we stay with the feeling instead of moving to an action step?",
      map: { map_resistance_complete: true, signature_id: "NE+S+R" },
      coachMemoryContext: {
        failure_strategy: "pull away when close",
        protector_rule: "stay safe",
        core_fear: "abandonment",
        initial_diagnostic: { q1: "x" },
      },
    });
    expect(transition.coaching_mode).toBe("discovery");
    expect(transition.stop_discovery).toBe(false);
    expect(transition.reasons).toContain("anti_repeat_discovery_only");
  });
});
