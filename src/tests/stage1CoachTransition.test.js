const { resolveCoachingTransition } = require("../stage1/coach/flows/transition");

const richMemoryContext = () => ({
  failure_strategy: "Delay disguised as refinement",
  protector_rule: "I protect myself by avoiding emotional pain from failure",
  recent_resistance_patterns: [
    "i protect myself by avoiding emotional pain from failure",
    "overthinking before action",
  ],
  recent_proofs: [{ action: "i competed 12 dollar an hr", at: "2026-06-01" }],
  last_ended_session: {
    detected_pattern: "proof_devaluation_collapse",
    narrative:
      "you put in effort (12 hrs yesterday), judged it as not enough (too little), then motivation dropped",
  },
  coaching_summary: "proof devaluation then collapse",
});

const completeMap = () => ({
  map_resistance_complete: true,
  failure_strategy: { rule: "Delay disguised as refinement" },
  success_strategy: { behaviour: "Take visible action before perfect clarity" },
  protector_rule: "I protect myself by avoiding emotional pain from failure",
  core_fear: "Failure and rejection",
  daily_rep: {
    name: "Income Action Block",
    steps: ["Pick one income task", "Do it for 25 minutes"],
    win_condition: "Log one proof of income-related action",
  },
});

describe("stage1CoachTransition", () => {
  test("execute mode on avoidance when resistance and pattern already known", () => {
    const t = resolveCoachingTransition({
      messages: [],
      userMessage: "I slept the whole day.",
      map: completeMap(),
      coachMemoryContext: richMemoryContext(),
    });

    expect(t.coaching_mode).toBe("execute");
    expect(t.stop_discovery).toBe(true);
    expect(t.coaching_brief).toBeTruthy();
    expect(t.coaching_brief.must_assign_green_rep).toBe(true);
    expect(t.coaching_brief.no_reflective_questions).toBe(true);
    expect(t.reasons).toContain("avoidance_reported");
  });

  test("explore when map resistance not complete", () => {
    const t = resolveCoachingTransition({
      messages: [],
      userMessage: "I slept the whole day.",
      map: { map_resistance_complete: false },
      coachMemoryContext: richMemoryContext(),
    });

    expect(t.coaching_mode).toBe("discovery");
    expect(t.coaching_phase).toBe("explore");
  });

  test("directive when session reveals win collapse chain", () => {
    const t = resolveCoachingTransition({
      messages: [
        { role: "user", content: "I earned $12 yesterday" },
        { role: "user", content: "It felt like too little" },
      ],
      userMessage: "So today I did nothing",
      map: completeMap(),
      coachMemoryContext: {},
    });

    expect(["directive", "execute"]).toContain(t.coaching_phase);
    expect(t.stop_discovery).toBe(true);
  });
});
