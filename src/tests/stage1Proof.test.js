const {
  recordProof,
  computeRepCompletionRate,
  buildWeeklyRepCompletion,
} = require("../helpers/stage1Proof");
const { emptyStage1State, defaultDomainMap } = require("../helpers/stage1State");

describe("stage1Proof", () => {
  const baseStage1 = () => {
    const map = {
      ...defaultDomainMap("income"),
      status: "active",
      goals_complete: true,
      map_resistance_complete: true,
      goal_title: "Test",
      desired_outcome: "Outcome",
      target_date: "90d",
      proof_of_success: "Done",
      milestones: { day_7: "a", day_30: "b", day_90: "c" },
      today_visible_action: "Email",
    };
    return {
      ...emptyStage1State(),
      primary_domain: "income",
      active_domains: ["income"],
      domain_maps: [map],
      proof_logs: [],
    };
  };

  test("recordProof rejects short action", () => {
    const r = recordProof(baseStage1(), { domain: "income", action: "ok" });
    expect(r.ok).toBe(false);
  });

  test("recordProof appends log and updates rep rate", () => {
    const r = recordProof(baseStage1(), {
      domain: "income",
      action: "Sent launch date to Lee",
      type: "action",
    });
    expect(r.ok).toBe(true);
    expect(r.stage1.proof_logs).toHaveLength(1);
    expect(r.progress_metrics.rep_completion_rate).toBeGreaterThan(0);
  });

  test("computeRepCompletionRate counts distinct days", () => {
    const today = new Date().toISOString();
    const logs = [
      { domain: "income", type: "action", created_at: today },
      { domain: "income", type: "action", created_at: today },
    ];
    const rate = computeRepCompletionRate(logs, "income");
    expect(rate).toBeCloseTo(1 / 7, 3);
  });

  test("buildWeeklyRepCompletion returns 7 days", () => {
    const w = buildWeeklyRepCompletion([], "income");
    expect(w.days).toHaveLength(7);
    expect(w.total).toBe(7);
  });
});
