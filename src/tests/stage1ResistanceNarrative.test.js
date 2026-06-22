const { enrichResistanceNarrative } = require("../helpers/stage1ResistanceNarrative");
const { inferStructureType } = require("../helpers/stage1InferStructureType");

describe("enrichResistanceNarrative", () => {
  test("builds contradiction and takeover from goal + structure", () => {
    const result = enrichResistanceNarrative(
      {
        goal_title: "Earn consistent income",
        desired_outcome: "25 sales in 90 days",
        protector_rule: "I must be perfect to be accepted",
        orbit_pattern: "hide → stay small → panic → withdraw",
        top_3_avoidance_behaviours: [
          "avoid pricing conversations",
          "hide bank reality",
          "don't follow up invoices",
        ],
        failure_strategy: {
          title: "Staying Invisible",
          rule: "I must be perfect to be accepted",
          behaviours: [
            "avoid pricing conversations",
            "hide bank reality",
            "don't follow up invoices",
          ],
        },
        success_strategy: {
          title: "Be Financially Visible",
          belief: "I am safe to be seen and not be ready",
          success_rule: "State price clearly, follow up payment",
          behaviours: [
            "state price clearly",
            "follow up payment",
            "name the number out loud",
          ],
        },
        core_fear: "rejection and judgment",
      },
      {
        activeGoalContext: {
          specific_goal: "Earn consistent income",
          measurable_outcome: "25 sales in 90 days",
        },
      },
    );

    expect(result.contradiction_statement).toMatch(/Earn consistent income/i);
    expect(result.contradiction_statement).toMatch(/Staying Invisible|perfect/i);
    expect(result.structure_type).toBeTruthy();
    expect(result.structure_takeover_moment.trigger).toMatch(/rejection/i);
    expect(result.structure_takeover_moment.rule_obeyed).toMatch(/perfect/i);
    expect(result.flip_belief).toMatch(/safe to be seen/i);
    expect(result.flip_90_day_projection).toMatch(/90 days/i);
  });

  test("preserves LLM-provided narrative fields", () => {
    const result = enrichResistanceNarrative({
      contradiction_statement: "Custom contradiction",
      structure_type: "Towards & Away",
      flip_90_day_projection: "Custom projection",
    });
    expect(result.contradiction_statement).toBe("Custom contradiction");
    expect(result.structure_type).toBe("Towards & Away");
    expect(result.flip_90_day_projection).toBe("Custom projection");
  });
});

describe("inferStructureType (stage1InferStructureType)", () => {
  test("hide → panic → withdraw maps to Towards & Away", () => {
    expect(
      inferStructureType({ orbit_pattern: "hide → stay small → panic → withdraw" }),
    ).toBe("Towards & Away");
  });
});
