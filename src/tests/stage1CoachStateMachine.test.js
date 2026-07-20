const { resolveCoachTurn, COACH_STATE } = require("../stage1/coach/legacy/stateMachine");
const { initCheckInProgress } = require("../stage1/coach/legacy/checkInFlow");
const { buildProgressIntegrationFromContinuity } = require("../stage1/coach/utils/progress");

const careerMap = {
  domain: "income",
  top_3_avoidance_behaviours: ["overthinking"],
  coaching_memory: { green_rep_history: [{ name: "Outreach Practice" }] },
};

describe("stage1CoachStateMachine", () => {
  test("check-in reply with proof+devaluation skips to devaluation loop", () => {
    const continuity = {
      had_proof: true,
      recent_proof: ["i competed 12 dollar an hr"],
    };
    const checkIn = initCheckInProgress(continuity);
    const seeded = buildProgressIntegrationFromContinuity(continuity);

    const turn = resolveCoachTurn({
      userMessage: "yes i worked 2 hrs and double the amount but it feels not enough",
      messages: [],
      openSession: { progress_integration: seeded, coach_state_last: "check_in" },
      checkInProgress: checkIn,
      stage1: { domain_maps: [], coach_session_log: [] },
      domain: "income",
      map: careerMap,
      userSelectedState: "clear",
    });

    expect(turn.coach_state).toBe(COACH_STATE.POST_PROOF_DEVALUATION);
    expect(turn.assistant_message).toMatch(/What standard are you measuring/);
    expect(turn.assistant_message).not.toContain("That's important");
  });
});
