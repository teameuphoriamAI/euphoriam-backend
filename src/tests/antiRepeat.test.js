const {
  buildAntiRepeatState,
  detectUserRejectsPrescription,
  detectThematicAssistantRepeat,
  detectRepeatedAssistantAdvice,
  shouldDefaultExploreFirst,
  guardAssistantReplyAgainstRepeat,
  isMechanismReady,
  detectSessionWantsNextStep,
  USER_WANTS_ACTION_PATTERN,
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

  test("understand why alone is not a hard prescription reject", () => {
    expect(
      detectUserRejectsPrescription([
        "I think I'm trying to understand why uncertainty feels so threatening in the first place.",
      ]),
    ).toBe(false);
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

  test("explore-first activates for relationships domain on turn 1", () => {
    expect(
      shouldDefaultExploreFirst({
        domain: "relationships",
        userMessage: "I pull away when I get close. I want to understand why.",
        user_asked_what_next: false,
      }),
    ).toBe(true);

    const signals = buildCoachConversationSignals({
      messages: [],
      userMessage: "I pull away when I get close. I want to understand why.",
      map: { domain: "relationships", map_resistance_complete: true },
    });
    expect(signals.explore_first_mode).toBe(true);
    expect(signals.discovery_only_mode).toBe(true);
    expect(signals.assign_new_rep).toBe(false);
    expect(signals.coaching_directive).toMatch(/EXPLORE FIRST/i);
  });

  test("opening next-step intention matches action pattern", () => {
    const open =
      "I want to figure out why I keep avoiding it and leave this session knowing the next step.";
    expect(USER_WANTS_ACTION_PATTERN.test(open)).toBe(true);
    expect(detectSessionWantsNextStep([open])).toBe(true);
  });

  test("mechanism ready exits explore-first and allows green rep path", () => {
    const map = {
      domain: "relationships",
      map_resistance_complete: true,
      protector_rule: "Avoid to prevent proving I'm not enough",
      core_fear: "Not being chosen",
      failure_strategy: { rule: "Pull away before rejection" },
    };

    const turns = [];
    const push = (role, content) => turns.push({ role, content });
    push(
      "user",
      "I've been putting off messaging a friend. I want to figure out why and leave knowing the next step.",
    );
    push("assistant", "What fear shows up when you imagine sending it?");
    push(
      "user",
      "I felt a knot in my stomach — fear of being misunderstood or rejected.",
    );
    push("assistant", "What are you experiencing in your body?");
    push("user", "Heaviness in my chest. My body wants to pull back.");
    push("assistant", "What is that protective part trying to protect you from?");
    push(
      "user",
      "If I'm vulnerable and they don't respond, it'll prove something is wrong with me.",
    );
    push("assistant", "What evidence supports or contradicts that fear?");
    push(
      "user",
      "Assumptions drive the fear. People do care about me, but positive moments feel like exceptions.",
    );
    push("assistant", "What might shift if positives held more weight?");
    push(
      "user",
      "I'd be less controlled by fear, but my protective part resists letting go of the guard.",
    );
    push("assistant", "If you didn't pull away, what would you fear next?");

    const userMessage =
      "I'd have to face uncertainty without protecting myself first. I want the next step.";
    expect(
      isMechanismReady({
        messages: turns,
        userMessage,
        map,
      }),
    ).toBe(true);

    expect(
      shouldDefaultExploreFirst({
        domain: "relationships",
        userMessage,
        messages: [...turns, { role: "user", content: userMessage }],
        map,
        mechanism_ready: true,
        session_wants_next_step: true,
      }),
    ).toBe(false);

    const signals = buildCoachConversationSignals({
      messages: turns,
      userMessage,
      map,
      memoryCtx: {},
      goalContext: { domain: "relationships" },
    });
    expect(signals.mechanism_ready).toBe(true);
    expect(signals.discovery_only_mode).toBe(false);
    expect(signals.explore_first_mode).toBe(false);
    expect(signals.assign_new_rep || signals.assign_green_rep).toBe(true);
    expect(signals.stop_discovery).toBe(true);
    expect(signals.coaching_directive).toMatch(/MECHANISM CLEAR/i);

    const transition = resolveCoachingTransition({
      messages: turns,
      userMessage,
      map,
      coachMemoryContext: {
        failure_strategy: map.failure_strategy,
        protector_rule: map.protector_rule,
        core_fear: map.core_fear,
        initial_diagnostic: { q1: "x" },
      },
      goalContext: { domain: "relationships", goal_title: "Stronger relationships" },
    });
    expect(transition.stop_discovery).toBe(true);
    expect(transition.coaching_mode).not.toBe("discovery");
    expect(transition.coaching_brief?.assign_green_rep).toBe(true);
  });

  test("guardAssistantReplyAgainstRepeat swaps exact duplicate", () => {
    const prior = "Tell me more about the last time that pull-away feeling showed up.";
    const out = guardAssistantReplyAgainstRepeat({
      assistant: prior,
      messages: [{ role: "assistant", content: prior }],
      userMessage: "I want to understand what's underneath.",
    });
    expect(out.trim()).not.toBe(prior.trim());
  });

  test("guardAssistantReplyAgainstRepeat keeps text when discovery fallback disabled", () => {
    const prior = "Tell me more about the last time that pull-away feeling showed up.";
    const out = guardAssistantReplyAgainstRepeat({
      assistant: prior,
      messages: [{ role: "assistant", content: prior }],
      userMessage: "I want to understand what's underneath.",
      allowDiscoveryFallback: false,
    });
    expect(out.trim()).toBe(prior.trim());
  });

  test("ensureActionReplyWhenRepAssigned is a passthrough (no canned rewrite)", () => {
    const { ensureActionReplyWhenRepAssigned } = require("../stage1/coach/signals/antiRepeat");
    const prior = "What are you experiencing right now — in your body, not your head?";
    const out = ensureActionReplyWhenRepAssigned({
      assistant: prior,
      greenRep: { name: "Send one check-in message" },
      assignGreenRep: true,
    });
    expect(out).toBe(prior);
  });

  test("assistantAlreadyAssignedRep detects prior rep in chat", () => {
    const { assistantAlreadyAssignedRep } = require("../stage1/coach/signals/antiRepeat");
    expect(
      assistantAlreadyAssignedRep([
        {
          role: "assistant",
          content: 'Today\'s rep is "Start Client Conversation". Check for a reply.',
        },
      ]),
    ).toBe(true);
    expect(
      assistantAlreadyAssignedRep([{ role: "assistant", content: "What do you notice in your body?" }]),
    ).toBe(false);
  });
});
