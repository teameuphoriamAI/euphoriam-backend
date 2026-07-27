// Tests for the buildFilters helper in marketResearchAggregator.js
// Isolate by mocking sequelize + withDbSlot (not needed for pure filter logic).

jest.mock("../config/sequelize", () => ({
  sequelize: { query: jest.fn() },
  withDbSlot: (fn) => fn(),
}));

// We can't import the private buildFilters directly, but we can test its
// observable behaviour through what getMarketResearchData passes to sequelize.query.
// Instead, extract the logic by re-testing the exported functions with a mock DB.

const { QueryTypes } = require("sequelize");
const { sequelize, withDbSlot } = require("../config/sequelize");

// Stub sequelize.query to capture calls and return empty arrays
beforeEach(() => {
  sequelize.query.mockResolvedValue([{ total: "0" }]);
});

afterEach(() => {
  jest.clearAllMocks();
});

const { getMarketResearchData } = require("../helpers/marketResearchAggregator");

describe("getMarketResearchData — filter injection into SQL", () => {
  test("default filter uses invisible_red_line report_type", async () => {
    await getMarketResearchData({});
    const firstCall = sequelize.query.mock.calls[0];
    const [sql, opts] = firstCall;
    expect(sql).toContain("invisible_red_line");
    expect(opts.bind).not.toHaveProperty("report_type");
  });

  test("date_from is forwarded as bind param and included in SQL", async () => {
    await getMarketResearchData({ date_from: "2026-01-01" });
    const firstCall = sequelize.query.mock.calls[0];
    const [sql, opts] = firstCall;
    expect(sql).toContain("date_from");
    expect(opts.bind).toHaveProperty("date_from", "2026-01-01");
  });

  test("date_to is forwarded as bind param and included in SQL", async () => {
    await getMarketResearchData({ date_to: "2026-03-31" });
    const firstCall = sequelize.query.mock.calls[0];
    const [sql, opts] = firstCall;
    expect(sql).toContain("date_to");
    expect(opts.bind).toHaveProperty("date_to", "2026-03-31");
  });

  test("funnel_source is forwarded as bind param", async () => {
    await getMarketResearchData({ funnel_source: "masterclass-jan-2026" });
    const firstCall = sequelize.query.mock.calls[0];
    const [, opts] = firstCall;
    expect(opts.bind).toHaveProperty("funnel_source", "masterclass-jan-2026");
  });

  test("user_audience=bronze (Creator Club) joins users and filters map resistance", async () => {
    await getMarketResearchData({ user_audience: "bronze" });
    const firstCall = sequelize.query.mock.calls[0];
    const [sql] = firstCall;
    expect(sql).toContain("LEFT JOIN users u");
    expect(sql).toContain("map_resistance_domain");
    expect(sql).not.toContain("structuredPacket");
  });

  test("user_audience=uc alias maps to Creator Club tier", async () => {
    await getMarketResearchData({ user_audience: "uc" });
    const firstCall = sequelize.query.mock.calls[0];
    const [sql] = firstCall;
    expect(sql).toContain("LEFT JOIN users u");
    expect(sql).toContain("map_resistance_domain");
  });

  test("user_audience=free filters funnel rows and requires structuredPacket", async () => {
    await getMarketResearchData({ user_audience: "non_member" });
    const firstCall = sequelize.query.mock.calls[0];
    const [sql, opts] = firstCall;
    expect(sql).toContain("funnel_access_id IS NOT NULL");
    expect(sql).toContain("structuredPacket");
    expect(opts.bind).not.toHaveProperty("report_type");
  });

  test("user_audience=both does not filter by report_type or require structuredPacket", async () => {
    await getMarketResearchData({ user_audience: "both" });
    const firstCall = sequelize.query.mock.calls[0];
    const [sql, opts] = firstCall;
    expect(opts.bind).not.toHaveProperty("report_type");
    expect(sql).not.toContain("structuredPacket");
  });

  test("default funnel IRL joins users for plan labels (Redline / Creator Club / …)", async () => {
    await getMarketResearchData({});
    const firstCall = sequelize.query.mock.calls[0];
    const [sql] = firstCall;
    expect(sql).toContain("LEFT JOIN users u");
  });

  test("user_audience=non_member still joins users for plan labels", async () => {
    await getMarketResearchData({ user_audience: "non_member" });
    const firstCall = sequelize.query.mock.calls[0];
    const [sql] = firstCall;
    expect(sql).toContain("LEFT JOIN users u");
    expect(sql).toContain("funnel_access_id IS NOT NULL");
  });

  test("user_audience=paid joins users and queries plan tier breakdown", async () => {
    await getMarketResearchData({ user_audience: "paid" });
    const tierCall = sequelize.query.mock.calls.find(([sql]) =>
      sql.includes("Creator Club") && sql.includes("Accelerate")
    );
    expect(tierCall).toBeTruthy();
  });

  test("plan distribution uses product names not generic app labels", async () => {
    await getMarketResearchData({ user_audience: "both" });
    const planCall = sequelize.query.mock.calls.find(([sql]) =>
      sql.includes("'Redline'") && sql.includes("'Creator Club'") && sql.includes("'Accelerate'")
    );
    expect(planCall).toBeTruthy();
    const genericCall = sequelize.query.mock.calls.find(([sql]) =>
      sql.includes("legacy_app") || sql.includes("paid_member_app")
    );
    expect(genericCall).toBeFalsy();
  });

  test("no filters → only structuredPacket presence check in SQL", async () => {
    await getMarketResearchData({});
    const firstCall = sequelize.query.mock.calls[0];
    const [sql] = firstCall;
    expect(sql).toContain("structuredPacket");
  });

  test("total_diagnostics is parsed as integer from query result", async () => {
    sequelize.query.mockResolvedValueOnce([{ total: "42" }]);
    // Subsequent calls return empty arrays
    sequelize.query.mockResolvedValue([]);

    const data = await getMarketResearchData({});
    expect(data.total_diagnostics).toBe(42);
    expect(typeof data.total_diagnostics).toBe("number");
  });

  test("returns correct shape with all expected keys", async () => {
    sequelize.query.mockResolvedValue([]);
    sequelize.query.mockResolvedValueOnce([{ total: "5" }]);

    const data = await getMarketResearchData({});
    const expectedKeys = [
      "total_diagnostics",
      "user_audience",
      "report_source",
      "field_coverage",
      "date_range",
      "eo_distribution",
      "lack_distribution",
      "avoid_distribution",
      "top_vortex_signatures",
      "domain_distribution",
      "gravity_depth_distribution",
      "cl_estimate_avg",
      "cl_estimate_distribution",
      "structure_type_distribution",
      "top_desired_outcomes",
      "top_orbit_patterns",
      "funnel_sources",
      "membership_tier_distribution",
      "kajabi_offer_distribution",
      "recovery_speed_distribution",
      "contradiction_rate_distribution",
    ];
    for (const key of expectedKeys) {
      expect(data).toHaveProperty(key);
    }
  });
});
