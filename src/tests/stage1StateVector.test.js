const {
  buildStateVectorV2,
  validateStateVectorV2,
} = require("../helpers/stage1StateVector");

describe("stage1StateVector", () => {
  const sampleMap = {
    domain: "income",
    goal_title: "Launch funnel",
    desired_outcome: "25 UC sales",
    target_date: "90 days",
    signature_id: "NON_S_R",
    failure_strategy: "Delay disguised as refinement",
    success_strategy: "Move first. Refine second.",
    daily_rep: "Send launch date",
    progress_metrics: { avoidance_caught_count: 2 },
    treatment_plan_30d: {
      current_week: 2,
      current_day: 10,
      weekly_focus: { week_2: "Visibility reps" },
    },
  };

  test("buildStateVectorV2 includes goal and treatment fields", () => {
    const vector = buildStateVectorV2({
      userId: 1,
      stage1: {},
      map: sampleMap,
      domain: "income",
      checkin: { current_state: "clear", gravity_rating: 5 },
    });
    expect(vector.active_domain).toBe("income");
    expect(vector.specific_goal).toBe("Launch funnel");
    expect(vector.treatment_week).toBe(2);
    expect(vector.weekly_focus).toBe("Visibility reps");
    expect(vector.failure_strategy).toMatch(/Delay/);
  });

  test("validateStateVectorV2 requires active_domain and specific_goal", () => {
    expect(validateStateVectorV2({ active_domain: "income" }).ok).toBe(false);
    expect(
      validateStateVectorV2({ active_domain: "income", specific_goal: "X" }).ok,
    ).toBe(true);
  });
});
