const {
  isStaleOpenSession,
  closeStaleOpenSessionIfNeeded,
  SESSION_GAP_MS,
} = require("../stage1/coach/persistence/history");

describe("coach session stale resume", () => {
  test("isStaleOpenSession when started on a prior calendar day", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    expect(
      isStaleOpenSession({ started_at: yesterday.toISOString() }),
    ).toBe(true);
  });

  test("isStaleOpenSession when same day but beyond SESSION_GAP_MS", () => {
    const old = new Date(Date.now() - SESSION_GAP_MS - 1000);
    expect(isStaleOpenSession({ started_at: old.toISOString() })).toBe(true);
  });

  test("isStaleOpenSession false for recent same-day session", () => {
    const recent = new Date(Date.now() - 30 * 60 * 1000);
    expect(isStaleOpenSession({ started_at: recent.toISOString() })).toBe(false);
  });

  test("closeStaleOpenSessionIfNeeded ends yesterday open session", () => {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    const stage1 = {
      coach_session_log: [
        {
          id: "coach-old",
          domain: "income",
          started_at: yesterday.toISOString(),
          ended_at: null,
          messages: [{ role: "assistant", content: "Old opening" }],
        },
      ],
    };
    const { stage1: next, closed } = closeStaleOpenSessionIfNeeded(stage1, "income");
    expect(closed).toBe(true);
    expect(next.coach_session_log[0].ended_at).toBeTruthy();
  });

  test("getResumableCoachMessages returns empty for ended session", () => {
    const { getResumableCoachMessages } = require("../stage1/coach/persistence/history");
    const stage1 = {
      coach_session_log: [
        {
          id: "coach-ended",
          domain: "income",
          started_at: new Date().toISOString(),
          ended_at: new Date().toISOString(),
          messages: [{ role: "user", content: "Old proof about boat" }],
        },
      ],
    };
    expect(getResumableCoachMessages(stage1, "income")).toEqual([]);
  });
});
