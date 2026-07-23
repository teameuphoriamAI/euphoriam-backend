const { stage1FeatureFlags, truthy } = require("../helpers/stage1FeatureFlags");

describe("stage1FeatureFlags", () => {
  const env = { ...process.env };

  afterEach(() => {
    process.env = { ...env };
  });

  test("defaults all flags to false", () => {
    delete process.env.COACH_CERT_DEEP_ENABLED;
    delete process.env.BRAIN_PROMPT_V2_SHADOW;
    delete process.env.TREATMENT_PLAN_ENABLED;
    delete process.env.BRAIN_PROMPT_RAG_ENABLED;
    const flags = stage1FeatureFlags();
    expect(flags.coach_cert_deep_enabled).toBe(false);
    expect(flags.brain_prompt_v2_shadow).toBe(false);
    expect(flags.treatment_plan_enabled).toBe(false);
    expect(flags.brain_prompt_rag_enabled).toBe(false);
  });

  test("truthy parses common env values", () => {
    expect(truthy("true")).toBe(true);
    expect(truthy("1")).toBe(true);
    expect(truthy("yes")).toBe(true);
    expect(truthy("false")).toBe(false);
    expect(truthy(undefined)).toBe(false);
  });

  test("COACH_CERT_DEEP_ENABLED when set", () => {
    process.env.COACH_CERT_DEEP_ENABLED = "true";
    expect(stage1FeatureFlags().coach_cert_deep_enabled).toBe(true);
  });

  test("BRAIN_PROMPT_RAG_ENABLED when set", () => {
    process.env.BRAIN_PROMPT_RAG_ENABLED = "true";
    expect(stage1FeatureFlags().brain_prompt_rag_enabled).toBe(true);
  });
});
