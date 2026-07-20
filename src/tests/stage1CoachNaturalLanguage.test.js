const {
  buildHumanCoachOpening,
  sanitizeCoachUserFacingText,
  isSubstantiveCheckInAnswer,
  inferCoachingPhase,
} = require("../stage1/coach/context/naturalLanguage");
const { detectProgressSignals } = require("../stage1/coach/utils/progress");

describe("stage1CoachNaturalLanguage", () => {
  test("opening is conversational not a report", () => {
    const msg = buildHumanCoachOpening({
      firstName: "Yashal",
      activeGoalContext: {
        goal_name: "Generate $12/hour",
        current_milestone: "outreach",
      },
      map: {
        top_3_avoidance_behaviours: ["Overthinking before taking action"],
        failure_strategy: { rule: "Delay disguised as refinement" },
      },
      memory: { coaching_sessions: [{ ended_at: "2026-06-01", turn_count: 3 }] },
      coachContext: {
        coaching_sessions: [{ ended_at: "2026-06-01" }],
        last_green_rep_assigned: { name: "Outreach Practice" },
      },
      continuity: { last_session_ended_at: "2026-06-01" },
    });

    expect(msg).toMatch(/Hey Yashal/i);
    expect(msg).not.toContain("Current Goal:");
    expect(msg).not.toContain("Current Milestone:");
    expect(msg).not.toContain("Recent Patterns:");
    expect(msg).toMatch(/We're still on/i);
    expect(msg).toMatch(/outreach/i);
    expect(msg).toMatch(/What happened since our last session/i);
  });

  test("sanitizes framework jargon from coach text", () => {
    const out = sanitizeCoachUserFacingText(
      "Current Goal:\nIncome\nYour vortex signature shows high gravity depth.",
    );
    expect(out).not.toContain("Current Goal:");
    expect(out).not.toContain("vortex");
  });

  test("strips repeated Hey name greeting on coaching turns", () => {
    const out = sanitizeCoachUserFacingText("Hey Yashal, I hear you felt lazy today.", {
      stripGreetingName: "Yashal",
    });
    expect(out).not.toMatch(/^Hey Yashal/i);
    expect(out).toContain("lazy");
  });

  test("detects substantive answers and proof", () => {
    const sig = detectProgressSignals("I generated $12/hour", {});
    expect(isSubstantiveCheckInAnswer("I generated $12/hour", sig)).toBe(true);
    expect(isSubstantiveCheckInAnswer("not much", null)).toBe(false);
  });

  test("infers coaching phase from session evidence", () => {
    expect(inferCoachingPhase([], "busy")).toBe("explore");
    expect(
      inferCoachingPhase([{ role: "user", content: "I earned $12" }], "felt small"),
    ).toBe("transitioning");
    expect(
      inferCoachingPhase(
        [
          { role: "user", content: "I earned $12 yesterday" },
          { role: "user", content: "It felt like too little" },
        ],
        "So today I did nothing",
      ),
    ).toBe("directive");
  });
});
