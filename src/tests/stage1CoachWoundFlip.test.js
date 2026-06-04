const {
  inferCoreWound,
  detectAvoidanceRule,
  resolveAvoidanceRuleFromAnswer,
  handleWoundFlipTurn,
  enterFlipLeverage,
} = require("../helpers/stage1CoachWoundFlip");
const { initProgressIntegration } = require("../helpers/stage1CoachProgress");

describe("stage1CoachWoundFlip", () => {
  test("detects 24/7 avoidance rule", () => {
    expect(detectAvoidanceRule("maybe work 24 hrs 7 days")).toMatch(/grind/i);
  });

  test("inferCoreWound from not enough text", () => {
    expect(inferCoreWound("it feels not enough")).toBe("I'm not enough");
  });

  test("flip leverage uses wound-edge answer not stale 24/7 rule", () => {
    const state = initProgressIntegration({});
    state.devaluation_loop_complete = true;
    state.wound_edge_asked = true;
    state.step = "wound_edge";
    state.answers.avoidance_rule = "If I grind 24/7, then I'll finally be enough";

    const r = enterFlipLeverage(state, "that i earn so less");
    expect(r.assistant_message).toMatch(/You said "that i earn so less"/i);
    expect(r.assistant_message).toMatch(/earn this little|earn so less/i);
    expect(r.assistant_message).not.toMatch(/grind 24\/7/i);
    expect(state.answers.avoidance_rule).toMatch(/earn|little|less/i);
  });

  test("resolveAvoidanceRuleFromAnswer maps earn so less", () => {
    expect(resolveAvoidanceRuleFromAnswer("that i earn so less")).toMatch(
      /earn this little|doesn't count/i,
    );
  });

  test("after flip complete 24/7 gets brief hold not new loop", () => {
    const state = initProgressIntegration({});
    state.devaluation_loop_complete = true;
    state.wound_edge_asked = true;
    state.flip_complete = true;
    state.step = "integration_complete";
    const r = handleWoundFlipTurn(state, "work 24 hrs 7 days", {});
    expect(r.assistant_message).toMatch(/24\/7|counts/i);
    expect(r.assistant_message).not.toMatch(/What rule are you running/i);
  });
});
