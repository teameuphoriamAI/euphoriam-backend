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

  test("custom report_type is forwarded as bind param", async () => {
    await getMarketResearchData({ report_type: "full" });
    const firstCall = sequelize.query.mock.calls[0];
    const [, opts] = firstCall;
    expect(opts.bind).toHaveProperty("report_type", "full");
  });

  test("report_type=all removes the report_type filter entirely", async () => {
    await getMarketResearchData({ report_type: "all" });
    const firstCall = sequelize.query.mock.calls[0];
    const [, opts] = firstCall;
    expect(opts.bind).not.toHaveProperty("report_type");
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
      "recovery_speed_distribution",
      "contradiction_rate_distribution",
    ];
    for (const key of expectedKeys) {
      expect(data).toHaveProperty(key);
    }
  });
});
