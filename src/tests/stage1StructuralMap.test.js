const {
  buildStructuralMapForClient,
  buildMapResistanceBaseline,
  normalizeClDisplay,
} = require("../helpers/stage1StructuralMap");

describe("stage1StructuralMap", () => {
  test("normalizeClDisplay converts CL level 1-5 to 0-100", () => {
    expect(normalizeClDisplay(3)).toBe(60);
    expect(normalizeClDisplay(72)).toBe(72);
  });

  test("normalizeDiagnosticMetrics converts stored CL percentage to 1-5 scale", () => {
    const { normalizeDiagnosticMetrics } = require("../helpers/stage1StructuralMap");
    const normalized = normalizeDiagnosticMetrics({
      gravity: 60,
      consciousnessLevel: 50,
      qgcActivation: 30,
    });
    expect(normalized.consciousnessLevel).toBe(2.5);
  });

  test("formatConsciousnessLevel shows 1-5 scale not percentage", () => {
    const { formatConsciousnessLevel } = require("../helpers/stage1StructuralMap");
    expect(formatConsciousnessLevel(2)).toBe("2.0");
    expect(formatConsciousnessLevel(50)).toBe("2.5");
    expect(formatConsciousnessLevel(2.5)).toBe("2.5");
  });

  test("buildMapResistanceBaseline derives metrics from map resistance fields", () => {
    const map = {
      domain: "health",
      map_resistance_complete: true,
      map_resistance_completed_at: "2026-06-03T20:13:34.525Z",
      recovery_speed: "Slow",
      orbit_pattern: "avoid→delay",
      protector_rule: "Do not move until it feels certain.",
      top_3_avoidance_behaviours: ["delay", "phone", "later"],
      goals_complete: true,
      progress_metrics: { rep_completion_rate: 0.17, proof_logged_count: 3 },
      coaching_memory: {
        proof_logs: [
          { id: "1", type: "action", action: "walked" },
          { id: "2", type: "action", action: "walked again" },
          { id: "3", type: "resistance", action: "overslept" },
        ],
      },
    };

    const baseline = buildMapResistanceBaseline(map);
    expect(baseline.gravity_depth).toBe(2);
    expect(baseline.gravity_score).toBeGreaterThan(50);
    expect(baseline.cl_estimate).toBe(40);
    expect(baseline.integration_pct).toBe(17);
    expect(baseline.pillars.current_protector.gravity).toBeGreaterThan(
      baseline.pillars.current_lack.gravity,
    );
    expect(baseline.has_live_gravity).toBe(true);
  });

  test("buildStructuralMapForClient uses coach gravity rating and rep completion", () => {
    const map = {
      domain: "health",
      map_resistance_complete: true,
      recovery_speed: "Slow",
      orbit_pattern: "avoid→delay",
      protector_rule: "Do not move until it feels certain.",
      progress_metrics: { rep_completion_rate: 0.42 },
      coaching_memory: {
        coaching_sessions: [
          {
            session_id: "s1",
            gravity_rating_last: 7,
            cl_estimate: 4,
            ended_at: "2026-01-01T00:00:00.000Z",
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        ],
      },
    };

    const sm = buildStructuralMapForClient(map, { coach_session_log: [] });
    expect(sm.gravity_rating).toBe(7);
    expect(sm.gravity_score).toBe(70);
    expect(sm.integration_pct).toBe(42);
    expect(sm.pillars.current_protector.gravity).toBe(78);
    expect(sm.has_live_gravity).toBe(true);
    expect(Array.isArray(sm.progress_series)).toBe(true);
  });
});
