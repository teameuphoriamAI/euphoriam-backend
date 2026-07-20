const { buildCoachUserContext } = require("../stage1/coach/context/userContext");
const { emptyStage1State, defaultDomainMap } = require("../helpers/stage1State");

jest.mock("../helpers/euphoriamChatbot", () => ({
  getAllUserSessions: jest.fn().mockResolvedValue([
    {
      id: 1,
      sessionDate: "2026-01-15",
      summery: "Discussed fear of visibility",
      transcript: [{ role: "user", content: "I avoid sending emails" }],
      metadata: { fun: "hiking" },
    },
  ]),
}));

describe("stage1CoachContext", () => {
  test("buildCoachUserContext includes profile, map resistance, and sessions", async () => {
    const user = { id: 42, name: "Alex Morgan", email: "alex@test.com" };
    const map = {
      ...defaultDomainMap("income"),
      map_resistance_complete: true,
      goal_title: "Send emails daily",
      desired_outcome: "25 sales",
      failure_strategy: { rule: "Hide the ask" },
      success_strategy: { behaviour: "Send before perfect" },
      map_resistance_transcript: [
        { role: "assistant", content: "Q1 — resistance?" },
        { role: "user", content: "I delay" },
      ],
    };
    const stage1 = {
      ...emptyStage1State(),
      primary_domain: "income",
      coach_session_log: [
        {
          id: "coach-1",
          domain: "income",
          started_at: "2026-05-20T10:00:00Z",
          updated_at: "2026-05-20T10:05:00Z",
          ended_at: "2026-05-20T10:05:00Z",
          state_last: "clear",
          messages: [{ role: "user", content: "Feeling stuck" }],
          turn_count: 1,
        },
      ],
      proof_logs: [
        {
          id: "p1",
          domain: "income",
          action: "Sent one email",
          type: "action",
          created_at: "2026-05-21T09:00:00Z",
        },
      ],
      domain_maps: [map],
    };

    const ctx = await buildCoachUserContext(user, stage1, map, "income");

    expect(ctx.user_profile.first_name).toBe("Alex");
    expect(ctx.active_goal_context.goal_name).toBe("Send emails daily");
    expect(ctx.map_resistance.failure_strategy.rule).toBe("Hide the ask");
    expect(ctx.coaching_memory.initial_diagnostic.failure_strategy.rule).toBe(
      "Hide the ask",
    );
    expect(ctx.coaching_memory.initial_diagnostic).toBeTruthy();
    expect(ctx.recent_proof_logs).toHaveLength(1);
    expect(ctx.stage1_coach_sessions).toHaveLength(1);
    expect(ctx.user_sessions_1on1).toHaveLength(1);
    expect(ctx.user_sessions_1on1[0].summary).toContain("visibility");
  });
});
