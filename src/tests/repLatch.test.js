const {
  assistantAlreadyAssignedRep,
  parseRepNamesFromText,
  extractSessionRepFromMessages,
  stripUnauthorizedRepFromReply,
  stripEarlyPrescriptiveDiagnosis,
  fixDomainDiscoveryReply,
  stripDoubleRepFromReply,
  buildHoldReplyForUserMessage,
  isSessionRepLocked,
} = require("../stage1/coach/utils/repLatch");

describe("repLatch", () => {
  const assignText =
    'Today\'s next step is to do the "Start Client Conversation" rep:\n' +
    "- Check for a reply — if none in 24 hours, send one follow-up.\n" +
    'You win if you get one back-and-forth. Today\'s rep is "Outbound Client Touch": Pick one channel.';

  test("assistantAlreadyAssignedRep requires quoted rep name", () => {
    expect(assistantAlreadyAssignedRep([{ role: "assistant", content: assignText }])).toBe(true);
    expect(
      assistantAlreadyAssignedRep([
        {
          role: "assistant",
          content: "You win if you get one back-and-forth exchange or book a call.",
        },
      ]),
    ).toBe(false);
  });

  test("stripUnauthorizedRepFromReply removes broken Today's fragment", () => {
    const broken =
      "You're noticing the pattern clearly: you avoid follow-up. The cost of this pattern is lost momentum.\n\nToday's \n\nYou win if you get one back-and-forth exchange or book a call.\n\nReady to try this today?";
    const stripped = stripUnauthorizedRepFromReply(broken);
    expect(stripped).not.toMatch(/Today's/i);
    expect(stripped).not.toMatch(/You win if/i);
    expect(stripped).not.toMatch(/Ready to try/i);
  });

  test("stripEarlyPrescriptiveDiagnosis on turn 1", () => {
    const out = stripEarlyPrescriptiveDiagnosis(
      "You've clearly named the pattern: avoiding follow-up to protect yourself from rejection.",
      1,
    );
    expect(out).not.toMatch(/clearly named the pattern/i);
  });

  test("fixDomainDiscoveryReply on income", () => {
    const out = fixDomainDiscoveryReply(
      "What happens inside you the moment closeness starts to feel real?",
      "income",
    );
    expect(out).not.toMatch(/closeness/i);
    expect(out).toMatch(/follow-up|tab/i);
  });

  test("parseRepNamesFromText returns first rep only for stripDouble", () => {
    const names = parseRepNamesFromText(assignText);
    expect(names[0]).toMatch(/Start Client Conversation/i);
    expect(names.length).toBeGreaterThan(1);
    const stripped = stripDoubleRepFromReply(assignText);
    expect(stripped).toMatch(/Start Client Conversation/i);
    expect(stripped).not.toMatch(/Outbound Client Touch/i);
  });

  test("extractSessionRepFromMessages uses first assistant assign", () => {
    const out = extractSessionRepFromMessages([{ role: "assistant", content: assignText }]);
    expect(out?.name).toMatch(/Start Client Conversation/i);
  });

  test("stripUnauthorizedRepFromReply removes rep blocks in discover", () => {
    const stripped = stripUnauthorizedRepFromReply(
      'I hear you. Today\'s next step is to do the "Start Client Conversation" rep. You win if you book a call.',
    );
    expect(stripped).not.toMatch(/Today's next step/i);
  });

  test("buildHoldReplyForUserMessage answers action questions", () => {
    const rep = {
      name: "Start Client Conversation",
      steps: ["Send one follow-up with a specific question."],
    };
    expect(
      buildHoldReplyForUserMessage("What exactly should I do first — one message or one call?", rep),
    ).toMatch(/one message/i);
    expect(buildHoldReplyForUserMessage("i don't know", rep)).toMatch(/don't need certainty/i);
    expect(
      buildHoldReplyForUserMessage("What should I watch for in my body when the protector shows up?", rep),
    ).toMatch(/protector/i);
  });

  test("isSessionRepLocked from transcript", () => {
    expect(isSessionRepLocked(null, [{ role: "assistant", content: assignText }])).toBe(true);
  });
});
