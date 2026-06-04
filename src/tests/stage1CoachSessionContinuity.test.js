const { isPlausibleGreenRepName } = require("../helpers/stage1CoachGreenRepUtils");
const {
  gatherSessionContinuity,
  buildContinuityRecapLines,
  buildSessionSummaryFromCoachLog,
} = require("../helpers/stage1CoachSessionContinuity");
const { buildCoachOpeningCheckin } = require("../helpers/stage1CoachCheckInFlow");

describe("stage1CoachSessionContinuity", () => {
  test("rejects proof sentences as green rep names", () => {
    expect(isPlausibleGreenRepName("that i successfully generated 50 dollar an hour")).toBe(
      false,
    );
    expect(isPlausibleGreenRepName("Outreach Practice")).toBe(true);
  });

  test("opening includes last session proof and devaluation", () => {
    const continuity = {
      had_proof: true,
      had_devaluation: true,
      recent_proof: ["i competed 12 dollar an hr"],
      devaluation_notes: ["its soo less money", "not good enough"],
    };
    const msg = buildCoachOpeningCheckin({
      firstName: "Yashal",
      activeGoalContext: { goal_name: "12 dollar an hour", current_milestone: "10 dollar" },
      map: { top_3_avoidance_behaviours: ["overthinking"] },
      memory: {},
      coachContext: {},
      continuity,
    });

    expect(msg).toContain("Last session (carried forward)");
    expect(msg).toContain("i competed 12 dollar an hr");
    expect(msg).toContain("not enough");
    expect(msg).not.toContain("successfully generated 50 dollar");
    expect(msg).toMatch(/Since that session/i);
  });

  test("gatherSessionContinuity from ended coach session log", () => {
    const stage1 = {
      proof_logs: [
        {
          id: "p1",
          domain: "income",
          action: "i competed 12 dollar an hr",
          type: "action",
          created_at: "2026-06-01T12:00:00Z",
        },
      ],
      coach_session_log: [
        {
          id: "s1",
          domain: "income",
          ended_at: "2026-06-02T10:00:00Z",
          messages: [
            { role: "user", content: "i competed 12 dollar an hr" },
            { role: "user", content: "its soo less money" },
          ],
          progress_integration: {
            step: "complete",
            proof_logged: true,
            answers: { acknowledge_note: "i competed 12 dollar an hr" },
          },
          green_rep_last: { name: "that i successfully generated 50 dollar an hour" },
        },
      ],
    };
    const map = {
      domain: "income",
      coaching_memory: { proof_logs: stage1.proof_logs },
    };
    const c = gatherSessionContinuity(stage1, map, "income", {});
    expect(c.had_proof).toBe(true);
    expect(c.had_devaluation).toBe(true);
    expect(c.recent_proof[0]).toContain("12 dollar");
    expect(c.last_green_rep).toBeNull();
    const recap = buildContinuityRecapLines(c);
    expect(recap.length).toBeGreaterThan(2);
  });

  test("buildSessionSummaryFromCoachLog", () => {
    const summary = buildSessionSummaryFromCoachLog({
      messages: [
        { role: "user", content: "i competed 12 dollar an hr" },
        { role: "user", content: "less money" },
      ],
      progress_integration: {
        answers: { acknowledge_note: "12 dollar an hr", meaning_reflection: "i am capable" },
      },
    });
    expect(summary).toContain("Proof:");
    expect(summary).toContain("capable");
  });
});
