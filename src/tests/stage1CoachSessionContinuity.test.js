const { isPlausibleGreenRepName } = require("../stage1/coach/utils/greenRep");
const {
  gatherSessionContinuity,
  buildContinuityRecapLines,
  buildSessionSummaryFromCoachLog,
} = require("../stage1/coach/context/sessionContinuity");
const { buildCoachOpeningCheckin } = require("../stage1/coach/legacy/checkInFlow");

describe("stage1CoachSessionContinuity", () => {
  test("rejects proof sentences as green rep names", () => {
    expect(isPlausibleGreenRepName("that i successfully generated 50 dollar an hour")).toBe(
      false,
    );
    expect(isPlausibleGreenRepName("Outreach Practice")).toBe(true);
  });

  test("opening stays today-first; continuity kept out of chat dump", () => {
    const continuity = {
      had_proof: true,
      had_devaluation: true,
      recent_proof: ["i competed 12 dollar an hr"],
      last_session_narrative:
        "you put in effort (as i did 12 hrs yesterday), judged it as not enough (felt too little), then motivation dropped (idk)",
      session_summary:
        "you put in effort (as i did 12 hrs yesterday), judged it as not enough (felt too little), then motivation dropped (idk)",
      devaluation_notes: ["its soo less money", "not good enough"],
    };
    const msg = buildCoachOpeningCheckin({
      firstName: "Yashal",
      activeGoalContext: { goal_name: "12 dollar an hour", current_milestone: "10 dollar" },
      map: { top_3_avoidance_behaviours: ["overthinking"] },
      memory: { coaching_sessions: [{ ended_at: "2026-06-01", turn_count: 2 }] },
      coachContext: { coaching_sessions: [{ ended_at: "2026-06-01" }] },
      continuity: { ...continuity, last_session_ended_at: "2026-06-01" },
    });

    expect(msg).toMatch(/Hey Yashal/i);
    expect(msg).toMatch(/What brought you here today/i);
    expect(msg).toMatch(/We're working on/i);
    expect(msg).not.toContain("Last session (carried forward)");
    expect(msg).not.toContain("Current Goal:");
    expect(msg).not.toMatch(/Recent proof/i);
    expect(msg).not.toContain("i competed 12 dollar an hr");
    expect(msg).not.toMatch(/not enough/i);

    // Continuity still available for LLM/recap helpers — just not in opening chat
    const recap = buildContinuityRecapLines(continuity);
    expect(recap.join("\n")).toMatch(/12 dollar/i);
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
        { role: "user", content: "i didnt do anything today no earning today" },
        { role: "user", content: "as i did 12 hrs yesterday i felt i did too little so today i didnt earn anything no motivation" },
        { role: "user", content: "idk" },
      ],
      progress_integration: {
        answers: { acknowledge_note: "12 dollar an hr", meaning_reflection: "i am capable" },
      },
    });
    expect(summary).toContain("12 hrs yesterday");
    expect(summary).toContain("too little");
  });

  test("extractSessionNarrative detects win devaluation collapse", () => {
    const { extractSessionNarrative } = require("../stage1/coach/context/sessionContinuity");
    const narrative = extractSessionNarrative({
      messages: [
        { role: "user", content: "as i did 12 hrs yesterday i felt i did too little" },
        { role: "user", content: "so today i didnt earn anything no motivation" },
      ],
    });
    expect(narrative).toMatch(/12 hrs yesterday/i);
    expect(narrative).toMatch(/too little/i);
  });
});
