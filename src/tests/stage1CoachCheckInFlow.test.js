const {
  buildCoachOpeningCheckin,
  advanceCheckInConversation,
  initCheckInProgress,
  inferCheckInProgressFromMessages,
} = require("../stage1/coach/legacy/checkInFlow");

describe("stage1CoachCheckInFlow", () => {
  test("opening has human greeting and exactly one question", () => {
    const msg = buildCoachOpeningCheckin({
      firstName: "Yashal",
      activeGoalContext: {
        goal_name: "Generate $12/hour",
        current_milestone: "Generate $10/hour",
      },
      map: {
        top_3_avoidance_behaviours: ["Overthinking", "Delaying action"],
      },
      memory: {},
      coachContext: {},
    });

    expect(msg).toMatch(/Hey Yashal/i);
    expect(msg).toContain("Generate $12/hour");
    expect(msg).not.toContain("Current Goal:");
    expect(msg).not.toContain("Outreach Practice");
    expect(msg).toMatch(/What's been true since the map/i);
    expect(msg).toMatch(/interrupt that pattern/i);
    expect(msg).not.toContain("Did you complete");
  });

  test("substantive first answer skips rigid checklist", () => {
    let p = initCheckInProgress();
    const r = advanceCheckInConversation(p, "I generated $12/hour this week", {
      lastRepName: "Outreach Practice",
    });
    expect(r.ready_for_coaching).toBe(true);
    expect(r.assistant_message).toBeNull();
    expect(r.progress.answers.since_last_session).toContain("12/hour");
  });

  test("brief first answer gets one adaptive follow-up only", () => {
    let p = initCheckInProgress();
    let r = advanceCheckInConversation(p, "Busy week", {
      lastRepName: "Outreach Practice",
    });
    expect(r.session_phase).toBe("check_in");
    expect(r.assistant_message).toContain("Outreach Practice");
    expect(r.assistant_message).not.toMatch(/What feels hardest|Did you complete.*\?.*What/);

    p = r.progress;
    r = advanceCheckInConversation(p, "Not yet — kept putting it off", {
      lastRepName: "Outreach Practice",
    });
    expect(r.ready_for_coaching).toBe(true);
    expect(r.session_phase).toBe("coaching");
  });

  test("infers progress from legacy transcript", () => {
    const p = inferCheckInProgressFromMessages([
      { role: "assistant", content: "Hey — how have things been?" },
      { role: "user", content: "Busy week" },
      { role: "assistant", content: "How did outreach go?" },
      { role: "user", content: "yes done" },
    ]);
    expect(p.step).toBe("follow_up");
    expect(p.answers.since_last_session).toBe("Busy week");
  });
});
