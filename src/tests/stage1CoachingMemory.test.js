const {
  buildInitialDiagnosticSnapshot,
  captureInitialDiagnosticIfNeeded,
  recordCoachingMemoryTurn,
  serializeCoachingMemoryForCoach,
} = require("../helpers/stage1CoachingMemory");
const { defaultDomainMap } = require("../helpers/stage1State");

describe("stage1CoachingMemory", () => {
  const baseMap = () => ({
    ...defaultDomainMap("income"),
    map_resistance_complete: true,
    EO: "Needs Not OK",
    lack_channel: "Security",
    avoid_type: "Rejection",
    signature_id: "NE+S+R",
    core_fear: "Public failure",
    failure_strategy: { rule: "Hide the ask" },
    success_strategy: { behaviour: "Send before perfect" },
    daily_rep: { name: "Send one email", steps: [], win_condition: "Email sent" },
  });

  test("captureInitialDiagnosticIfNeeded freezes snapshot once", () => {
    const map = baseMap();
    const ctx = { goal_name: "Launch offer", current_milestone: "Week 1" };
    const first = captureInitialDiagnosticIfNeeded(map, ctx, "income");
    expect(first.coaching_memory.initial_diagnostic.EO).toBe("Needs Not OK");
    expect(first.coaching_memory.initial_diagnostic.core_fear).toBe("Public failure");

    const second = captureInitialDiagnosticIfNeeded(
      { ...first, EO: "Changed", core_fear: "New fear" },
      ctx,
      "income",
    );
    expect(second.coaching_memory.initial_diagnostic.EO).toBe("Needs Not OK");
    expect(second.EO).toBe("Changed");
  });

  test("recordCoachingMemoryTurn appends session with fears and green rep", () => {
    let map = captureInitialDiagnosticIfNeeded(baseMap(), null, "income");
    map = recordCoachingMemoryTurn(map, {
      session_id: "coach-abc",
      domain: "income",
      state: "clear",
      user_message: "Stuck on sales",
      assistant_message: "Name the protector",
      green_rep: { name: "Book one call", win_condition: "Call booked" },
      writeback_hints: {
        current_fear: "Fear of sales",
        current_resistance: "Avoiding outreach",
        session_summary: "Sales fear active",
      },
    });

    const history = map.coaching_memory.coaching_sessions;
    expect(history).toHaveLength(1);
    expect(history[0].current_fear).toBe("Fear of sales");
    expect(history[0].green_rep_assigned.name).toBe("Book one call");

    map = recordCoachingMemoryTurn(map, {
      session_id: "coach-abc",
      domain: "income",
      state: "progress",
      writeback_hints: { current_fear: "Fear of launching", green_rep_completed: true },
    });
    expect(map.coaching_memory.coaching_sessions[0].current_fear).toBe("Fear of launching");
    expect(map.coaching_memory.coaching_sessions[0].green_rep_completed).toBe(true);
  });

  test("serializeCoachingMemoryForCoach exposes evolution timeline", () => {
    let map = captureInitialDiagnosticIfNeeded(baseMap(), null, "income");
    map = recordCoachingMemoryTurn(map, {
      session_id: "s1",
      domain: "income",
      state: "clear",
      writeback_hints: { current_fear: "Fear of public coaching" },
    });
    map = recordCoachingMemoryTurn(map, {
      session_id: "s2",
      domain: "income",
      state: "clear",
      writeback_hints: { current_fear: "Fear of sales" },
    });

    const stage1 = {
      proof_logs: [
        {
          id: "p1",
          domain: "income",
          action: "Posted offer",
          type: "action",
          created_at: "2026-06-01T10:00:00Z",
        },
      ],
    };
    const serialized = serializeCoachingMemoryForCoach(map, stage1, "income");
    expect(serialized.initial_diagnostic.signature_id).toBe("NE+S+R");
    expect(serialized.coaching_sessions.length).toBeGreaterThanOrEqual(2);
    expect(serialized.resistance_evolution.length).toBeGreaterThanOrEqual(2);
    expect(serialized.proof_logs[0].action).toBe("Posted offer");
  });
});
