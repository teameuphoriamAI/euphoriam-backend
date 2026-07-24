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
      continuity: {
        last_session_ended_at: "2026-06-01",
        session_summary: "Last session: bought a boat and got sidetracked",
        last_green_rep: { name: "Outreach Practice" },
        recent_proof: ["Sent one outreach"],
      },
    });

    expect(msg).toMatch(/Hey Yashal/i);
    expect(msg).toMatch(/confidential/i);
    expect(msg).toMatch(/We're working on/i);
    expect(msg).toMatch(/Generate \$12\/hour/i);
    expect(msg).toMatch(/Good to see you/i);
    expect(msg).toMatch(/How are you today/i);
    expect(msg).toMatch(/What brought you here today/i);
    expect(msg).toMatch(/what do you want from this session/i);
    expect(msg).not.toContain("Current Goal:");
    expect(msg).not.toContain("Current Milestone:");
    expect(msg).not.toContain("Recent Patterns:");
    expect(msg).not.toMatch(/Last rep in play/i);
    expect(msg).not.toMatch(/Last time:/i);
    expect(msg).not.toMatch(/since our last session/i);
    expect(msg).not.toContain("bought a boat");
    expect(msg).not.toContain("Outreach Practice");
  });

  test("first session opening does not read Map Resistance aloud", () => {
    const msg = buildHumanCoachOpening({
      firstName: "Nathan",
      activeGoalContext: {
        goal_name: "$50k/month",
        current_milestone: "funnel live",
      },
      map: {
        contradiction_statement:
          "You want visibility but your protector keeps you private.",
        protector_rule: "Don't be seen or you'll be judged",
        failure_strategy: { rule: "Procrastinate on public offers" },
      },
      memory: {},
      coachContext: {},
      continuity: null,
    });

    expect(msg).toMatch(/Hey Nathan/i);
    expect(msg).toMatch(/confidential/i);
    expect(msg).toMatch(/We're working on/i);
    expect(msg).toMatch(/What brought you here today/i);
    expect(msg).not.toMatch(/From that map/i);
    expect(msg).not.toMatch(/finished mapping/i);
    expect(msg).not.toContain("protector");
    expect(msg).not.toContain("Procrastinate on public offers");
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
