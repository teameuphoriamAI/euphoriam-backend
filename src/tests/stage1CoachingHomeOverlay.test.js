const {
  buildCoachingHomeOverlay,
  applyCoachingToProgressMetrics,
} = require("../stage1/coach/legacy/homeOverlay");

describe("stage1CoachingHomeOverlay", () => {
  test("builds coaching layer without touching baseline fields", () => {
    const map = {
      domain: "income",
      failure_strategy: { rule: "QA baseline failure" },
      success_strategy: { behaviour: "QA baseline success" },
      daily_rep: { name: "QA rep" },
      coaching_memory: {
        initial_diagnostic: { captured_at: "2026-01-01", failure_strategy: { rule: "frozen" } },
        coaching_sessions: [
          {
            session_id: "s1",
            ended_at: "2026-02-01",
            current_failure_strategy: { rule: "Coach live failure" },
            green_rep_assigned: { name: "Outreach rep" },
            session_summary: "Worked 2 hrs",
          },
        ],
        proof_logs: [],
      },
    };
    const overlay = buildCoachingHomeOverlay(map, {
      proof_logs: [{ id: "p1", domain: "income", action: "earned $12", created_at: "2026-02-02" }],
    });
    expect(overlay.baseline_locked).toBe(true);
    expect(overlay.live_failure_strategy).toMatch(/Coach live/);
    expect(map.failure_strategy.rule).toBe("QA baseline failure");
    expect(overlay.proof_logged_count).toBeGreaterThan(0);
  });

  test("merges coach_session_log when coaching_memory sessions empty", () => {
    const map = {
      domain: "income",
      coaching_memory: { coaching_sessions: [], proof_logs: [] },
    };
    const overlay = buildCoachingHomeOverlay(map, {
      coach_session_log: [
        {
          id: "log-1",
          domain: "income",
          started_at: "2026-03-01",
          updated_at: "2026-03-01",
          ended_at: "2026-03-02",
          turn_count: 3,
          messages: [{ role: "user", content: "earned $12 an hr" }],
          progress_integration: {
            proof_logged: true,
            answers: {
              acknowledge_note: "earned $12 an hr",
              avoidance_rule: "earn so less does not count",
              leverage_note: "my kids need me to show up",
            },
          },
        },
      ],
    });
    expect(overlay.has_coaching_activity).toBe(true);
    expect(overlay.sessions_total).toBe(1);
    expect(overlay.failure_strategy.rule).toMatch(/earn so less/i);
    expect(overlay.success_strategy.behaviour).toMatch(/kids/i);
    expect(overlay.proof.length).toBeGreaterThan(0);
  });

  test("fills failure/success from diagnostic_observations when session fields empty", () => {
    const map = {
      domain: "income",
      coaching_memory: {
        coaching_sessions: [{ session_id: "s1", turn_count: 2, updated_at: "2026-06-04" }],
        diagnostic_observations: [
          {
            at: "2026-06-04T21:06:39.153Z",
            observation:
              "Core wound active: I'm not enough | Avoidance rule: If I grind 24/7, then I'll finally be enough | Flip leverage: when i get alot",
          },
        ],
        progress_logs: [
          { at: "2026-06-04", type: "coaching_note", note: "that i earn so less" },
        ],
        proof_logs: [],
      },
    };
    const overlay = buildCoachingHomeOverlay(map, { coach_session_log: [] });
    expect(overlay.failure_strategy.rule).toMatch(/grind 24\/7|earn so less/i);
    expect(overlay.success_strategy.behaviour || overlay.success_strategy.flip_leverage).toMatch(
      /when i get alot/i,
    );
    expect(overlay.live_failure_strategy).toBeTruthy();
  });

  test("applyCoachingToProgressMetrics boosts rep rate from sessions", () => {
    const pm = applyCoachingToProgressMetrics(
      { rep_completion_rate: 0.2, proof_logged_count: 1 },
      { has_coaching_activity: true, sessions_ended: 2, proof_logged_count: 2 },
    );
    expect(pm.coaching_sessions_ended).toBe(2);
    expect(pm.rep_completion_rate).toBeGreaterThan(0.2);
  });
});
