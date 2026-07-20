const { resolveCoachTurn, COACH_STATE } = require("../stage1/coach/legacy/stateMachine");
const { initCheckInProgress } = require("../stage1/coach/legacy/checkInFlow");
const { detectStruggleSetback } = require("../stage1/coach/signals/discovery");

describe("stage1CoachDiscovery routing", () => {
  test("detects setback without proof", () => {
    expect(detectStruggleSetback("bad i didnt do anything today")).toBe(true);
    expect(detectStruggleSetback("I generated $12/hour")).toBe(false);
  });

  test("setback routes to discovery not devaluation", () => {
    const continuity = {
      had_proof: true,
      recent_proof: ["i competed 12 dollar an hr"],
    };
    const turn = resolveCoachTurn({
      userMessage: "bad i didnt do anything today",
      messages: [],
      openSession: null,
      checkInProgress: initCheckInProgress(continuity),
      stage1: { proof_logs: [], coach_session_log: [] },
      domain: "income",
      map: { domain: "income", top_3_avoidance_behaviours: ["overthinking"] },
    });

    expect(turn.coach_state).toBe(COACH_STATE.DISCOVERY);
    expect(turn.assistant_message).toMatch(/What got in the way|plan to work|spend most/i);
    expect(turn.assistant_message).not.toMatch(/not enough after a win|overthinking.*value gets discounted/i);
    expect(turn.ready_for_coaching).toBe(false);
  });
});
