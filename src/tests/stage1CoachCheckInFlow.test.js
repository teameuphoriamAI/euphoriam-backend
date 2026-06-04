const {
  buildCoachOpeningCheckin,
  advanceCheckInConversation,
  initCheckInProgress,
  inferCheckInProgressFromMessages,
} = require("../helpers/stage1CoachCheckInFlow");

describe("stage1CoachCheckInFlow", () => {
  test("opening has recap and exactly one question", () => {
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

    expect(msg).toContain("Welcome back Yashal");
    expect(msg).toContain("Generate $12/hour");
    expect(msg).not.toContain("Outreach Practice");
    expect(msg).toContain("What happened since our last session?");
    expect(msg).not.toContain("Did you complete");
    expect(msg).not.toContain("1.");
  });

  test("advances one question at a time then coaching", () => {
    let p = initCheckInProgress();

    let r = advanceCheckInConversation(p, "I avoided outreach all week", {
      lastRepName: "Outreach Practice",
    });
    expect(r.session_phase).toBe("check_in");
    expect(r.assistant_message).toContain("Did you complete");
    expect(r.assistant_message).not.toContain("What feels hardest");

    p = r.progress;
    r = advanceCheckInConversation(p, "No not yet", { lastRepName: "Outreach Practice" });
    expect(r.session_phase).toBe("check_in");
    expect(r.assistant_message).toContain("What stopped you");

    p = r.progress;
    r = advanceCheckInConversation(p, "Fear of rejection on calls", {
      lastRepName: "Outreach Practice",
    });
    expect(r.ready_for_coaching).toBe(true);
    expect(r.session_phase).toBe("coaching");
    expect(r.assistant_message).toBeNull();
    expect(r.progress.answers.current_blocker).toContain("rejection");
  });

  test("infers progress from legacy transcript", () => {
    const p = inferCheckInProgressFromMessages([
      { role: "assistant", content: "Welcome" },
      { role: "user", content: "Busy week" },
      { role: "assistant", content: "Green rep?" },
      { role: "user", content: "yes done" },
    ]);
    expect(p.step).toBe("current_blocker");
    expect(p.answers.since_last_session).toBe("Busy week");
  });
});
