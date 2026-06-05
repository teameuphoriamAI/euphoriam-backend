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

  test("devaluation requires proof in same message or session acknowledge note", () => {
    const sig = detectProgressSignals("yes i worked 2 hrs but not enough", {});
    expect(detectPostProofDevaluation("yes i worked 2 hrs but not enough", sig, null)).toBe(true);
    expect(detectPostProofDevaluation("bad i didnt do anything today", sig, null)).toBe(false);
  });

  test("setback day does not trigger devaluation from prior session proof", () => {
    const integration = initProgressIntegration({});
    integration.answers.acknowledge_note = "i competed 12 dollar an hr";
    expect(
      detectPostProofDevaluation("bad i didnt do anything today", {}, integration),
    ).toBe(false);
  });

  test("continuity no longer seeds progress integration", () => {
    expect(buildProgressIntegrationFromContinuity({ had_proof: true })).toBeNull();
  });

  test("proof + downplay in one message enters devaluation loop", () => {
    let integration = initProgressIntegration({});
    const r = advanceProgressIntegration(
      integration,
      "yes i worked 2 hrs and double the amount but it feels not enough",
      { map: {}, patterns: ["overthinking"] },
    );
    expect(r.coach_state).toBe("post_proof_devaluation_loop");
    expect(r.assistant_message).toMatch(/What standard are you measuring/);
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
    });
    expect(r.coach_state).toBe("wound_edge");
    expect(r.assistant_message).not.toMatch(/What standard|What would it mean|real-world proof/i);
    expect(r.assistant_message).toMatch(/not enough|rule are you running/i);
  });
});
