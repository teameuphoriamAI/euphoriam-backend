/** Allow loading irlReportGenerator (pulls openai + sequelize) in CI without real secrets. */
if (!process.env.OPENAI_API_KEY) {
  process.env.OPENAI_API_KEY = "sk-test-placeholder-jest";
}
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL =
    "postgres://jest:jest@127.0.0.1:5432/euphoriam_jest_placeholder";
}

const {
  buildIrlInputContent,
  normalizeStage2PacketInputs,
  IRL_MIN_WORD_COUNT,
  IRL_MAX_COMPLETION_TOKENS,
} = require("../helpers/irlReportGenerator");

describe("irlReportGenerator (Phase B)", () => {
  test("IRL_MIN_WORD_COUNT is v2.2 floor (1000)", () => {
    expect(IRL_MIN_WORD_COUNT).toBe(1000);
  });

  test("IRL_MAX_COMPLETION_TOKENS is raised for long reports", () => {
    expect(IRL_MAX_COMPLETION_TOKENS).toBeGreaterThanOrEqual(3500);
  });

  test("buildIrlInputContent includes all v2.2 diagnostic_packet keys", () => {
    const block = buildIrlInputContent({
      user: { first_name: "A", timezone: "UTC" },
      diagnostic_packet: {
        domain_primary: "d",
        desired_outcome: "o",
        current_loop: "l",
        orbit_pattern: "op",
        EO: "e",
        lack_channel: "lc",
        protector_type: "pt",
        gravity_depth: "gd",
        CL_estimate: "1",
        CL_confidence: "c",
        structure_type: "st",
        protector_profile: { what_it_prevents: "w", typical_behaviours: ["a"] },
        rule_engine: "re",
        behaviour_evidence: "be",
        recovery_speed: "rs",
        contradiction_rate: "cr",
        signature_confidence: "sc",
        signature_primary_id: "p1",
        signature_secondary_id: "p2",
        predictions: "pr",
        falsifiers: "fa",
        confirmation_test: "ct",
        daily_rep_assigned: { name: "n", steps: ["s"], win_condition: "w" },
        recommended_resource: "rr",
        data_needed_next: "dn",
      },
      constraint_packet: {
        name: "cn",
        protector_rule: "pr",
        red_barrier_sentence: "rb",
        how_it_caps_output: "hc",
        good_intent: "gi",
        bad_cost: "bc",
        confidence: "cf",
        alt_hypothesis: "ah",
      },
      optional_inputs: {
        top_trigger_example: "t",
        recent_trigger_example: "r",
        abduction_sentence: "ab",
        main_avoidance_behaviours: ["x"],
        main_cost_domain: "m",
        personalised_offer_price: "p",
        personalised_offer_name: "pn",
        family_rule_summary: "f",
      },
      access_flags: { UC: false },
      offer_config: {},
    });

    const required = [
      "domain_primary:",
      "falsifiers:",
      "confirmation_test:",
      "recommended_resource:",
      "data_needed_next:",
      "daily_rep_assigned.name:",
      "predictions:",
    ];
    required.forEach((needle) => {
      expect(block).toContain(needle);
    });
    expect(block).toMatch(/timezone:\s*UTC/);
  });

  test("normalizeStage2PacketInputs fills missing keys without dropping extras", () => {
    const { diagnostic_packet, constraint_packet, optional_inputs } =
      normalizeStage2PacketInputs({
        diagnostic_packet: { predictions: "only this" },
        constraint_packet: {},
        optional_inputs: {},
      });
    expect(diagnostic_packet.predictions).toBe("only this");
    expect(diagnostic_packet.falsifiers).toBeNull();
    expect(diagnostic_packet.data_needed_next).toBeNull();
    expect(diagnostic_packet.protector_profile.typical_behaviours).toEqual([]);
    expect(constraint_packet.name).toBeNull();
    expect(Array.isArray(optional_inputs.main_avoidance_behaviours)).toBe(true);
  });
});
