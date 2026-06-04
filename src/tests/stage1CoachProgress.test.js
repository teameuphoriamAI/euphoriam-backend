const {
  detectProgressSignals,
  detectPostProofDevaluation,
  advanceProgressIntegration,
  buildProgressIntegrationFromContinuity,
  initProgressIntegration,
  PROGRESS_STEPS,
} = require("../helpers/stage1CoachProgress");

describe("stage1CoachProgress", () => {
  test("detects 2 hrs worked + not enough", () => {
    const s = detectProgressSignals(
      "yes i worked 2 hrs and double the amout but it feels its not enough",
      {},
    );
    expect(s.isStrong).toBe(true);
    expect(s.downplaysResult).toBe(true);
  });

  test("devaluation with continuity but empty integration", () => {
    const continuity = { had_proof: true, recent_proof: ["i competed 12 dollar an hr"] };
    const sig = detectProgressSignals("yes i worked 2 hrs but not enough", {});
    expect(
      detectPostProofDevaluation("yes i worked 2 hrs but not enough", sig, null, continuity),
    ).toBe(true);
  });

  test("first reply after continuity seeds devaluation loop not reflect", () => {
    const continuity = {
      had_proof: true,
      recent_proof: ["i competed 12 dollar an hr"],
    };
    let integration = buildProgressIntegrationFromContinuity(continuity);
    const r = advanceProgressIntegration(
      integration,
      "yes i worked 2 hrs and double the amount but it feels not enough",
      { map: {}, continuity, patterns: ["overthinking"] },
    );
    expect(r.coach_state).toBe("post_proof_devaluation_loop");
    expect(r.assistant_message).toMatch(/What standard are you measuring/);
    expect(r.assistant_message).not.toContain("That's important");
    expect(r.assistant_message).not.toMatch(/What would it mean/);
  });

  test("after loop complete enters wound edge not re-package", () => {
    let integration = initProgressIntegration({});
    integration.proof_logged = true;
    integration.devaluation_package_sent = true;
    integration.devaluation_loop_complete = true;
    integration.step = PROGRESS_STEPS.COMPLETE;
    integration.answers.acknowledge_note = "2 hrs work";
    integration.answers.devaluation_note = "not enough";

    const r = advanceProgressIntegration(integration, "maybe work 24 hrs 7 days", {
      map: {},
      continuity: { had_proof: true },
    });
    expect(r.coach_state).toBe("wound_edge");
    expect(r.assistant_message).not.toMatch(/What standard|What would it mean|real-world proof/i);
    expect(r.assistant_message).toMatch(/not enough|rule are you running/i);
  });

  test("full arc proof downplay wound flip", () => {
    const continuity = { had_proof: true, recent_proof: ["12 dollar an hr"] };
    let integration = buildProgressIntegrationFromContinuity(continuity);

    let r = advanceProgressIntegration(
      integration,
      "worked 2 hrs but not enough",
      { map: {}, continuity, patterns: ["overthinking"] },
    );
    integration = r.integration;
    expect(r.coach_state).toBe("post_proof_devaluation_loop");

    r = advanceProgressIntegration(integration, "idk", { map: {}, continuity });
    integration = r.integration;
    expect(integration.devaluation_loop_complete).toBe(true);

    r = advanceProgressIntegration(integration, "grind 24 hrs 7 days", { map: {}, continuity });
    integration = r.integration;
    expect(r.coach_state).toBe("wound_edge");
    expect(integration.wound_edge_asked).toBe(true);

    r = advanceProgressIntegration(
      integration,
      "if I don't grind I won't be enough",
      { map: {}, continuity },
    );
    integration = r.integration;
    expect(r.coach_state).toBe("flip_install");
    expect(r.assistant_message).toMatch(/must|preference|possible|cost/i);

    r = advanceProgressIntegration(
      integration,
      "my kids need me to show up differently",
      { map: {}, continuity },
    );
    integration = r.integration;
    expect(integration.flip_complete).toBe(true);
    expect(r.ready_for_resistance_coaching).toBe(true);
    expect(r.assistant_message).toMatch(/flip|leverage|land/i);
    expect(r.diagnostic_observation).toMatch(/Core wound|Avoidance|Flip leverage/i);
  });
});
