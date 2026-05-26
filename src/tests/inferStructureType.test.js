// Tests for the deterministic structure type inference in structuredPacketExtractor.js
// We isolate inferStructureType by extracting it with a manual mock for its dependencies.

// Mock dependencies that require DB/OpenAI so the file can be loaded in tests
jest.mock("../config/openai", () => ({}));
jest.mock("../models/promptModel", () => ({ Prompt: {} }));
jest.mock("../config/sequelize", () => ({
  withDbSlot: jest.fn(),
  sequelize: {},
}));

const { inferStructureType } = require("../helpers/structuredPacketExtractor");

describe("inferStructureType", () => {
  // ── Something's Wrong With Me ─────────────────────────────────────────────

  describe("Something's Wrong With Me", () => {
    test("self-blame + high contradiction → SWWM", () => {
      expect(
        inferStructureType({
          orbit_pattern: "shame loop → isolation",
          contradiction_rate: "high",
          CL_estimate: 2.0,
        })
      ).toBe("Something's Wrong With Me");
    });

    test("self-blame + very low CL (< 1.5) → SWWM", () => {
      expect(
        inferStructureType({
          orbit_pattern: "failure → blame myself → try again",
          contradiction_rate: "low",
          CL_estimate: 1.2,
        })
      ).toBe("Something's Wrong With Me");
    });

    test("broken language in orbit → SWWM with low CL", () => {
      expect(
        inferStructureType({
          orbit_pattern: "I feel broken and worthless",
          current_loop: "constant self blame",
          contradiction_rate: "medium",
          CL_estimate: 1.4,
        })
      ).toBe("Something's Wrong With Me");
    });

    test("self-blame alone without high contradiction or low CL does NOT trigger SWWM", () => {
      const result = inferStructureType({
        orbit_pattern: "shame → try harder",
        contradiction_rate: "low",
        CL_estimate: 2.5,
      });
      // Should fall through to another type
      expect(result).not.toBe("Something's Wrong With Me");
    });
  });

  // ── Towards & Away ────────────────────────────────────────────────────────

  describe("Towards & Away", () => {
    test("attach→withdraw pattern → T&A", () => {
      expect(
        inferStructureType({ orbit_pattern: "attach then withdraw when it gets real" })
      ).toBe("Towards & Away");
    });

    test("open→close pattern → T&A", () => {
      expect(
        inferStructureType({ orbit_pattern: "open up then close off" })
      ).toBe("Towards & Away");
    });

    test("connect→retreat pattern → T&A", () => {
      expect(
        inferStructureType({ orbit_pattern: "connect with people then retreat" })
      ).toBe("Towards & Away");
    });

    test("start→stop→start pattern → T&A", () => {
      expect(
        inferStructureType({ orbit_pattern: "start stop start again" })
      ).toBe("Towards & Away");
    });

    test("engage→disengage pattern → T&A", () => {
      expect(
        inferStructureType({ orbit_pattern: "engage with opportunity then disengage" })
      ).toBe("Towards & Away");
    });
  });

  // ── Progress with Snapback ────────────────────────────────────────────────

  describe("Progress with Snapback", () => {
    test("progress→collapse pattern → PwS", () => {
      expect(
        inferStructureType({ orbit_pattern: "progress then collapse when close" })
      ).toBe("Progress with Snapback");
    });

    test("succeed→sabotage pattern → PwS", () => {
      expect(
        inferStructureType({ orbit_pattern: "succeed then sabotage myself" })
      ).toBe("Progress with Snapback");
    });

    test("rise→fall pattern → PwS", () => {
      expect(
        inferStructureType({ orbit_pattern: "rise then fall back down" })
      ).toBe("Progress with Snapback");
    });

    test("almost→back pattern → PwS", () => {
      expect(
        inferStructureType({ orbit_pattern: "almost there then back to the start" })
      ).toBe("Progress with Snapback");
    });

    test("overwork→crash pattern → PwS", () => {
      expect(
        inferStructureType({ orbit_pattern: "overwork then crash" })
      ).toBe("Progress with Snapback");
    });
  });

  // ── Orbit (default) ───────────────────────────────────────────────────────

  describe("Orbit (default)", () => {
    test("no matching pattern → defaults to Orbit", () => {
      expect(
        inferStructureType({
          orbit_pattern: "circling the same goal",
          contradiction_rate: "medium",
          CL_estimate: 2.2,
        })
      ).toBe("Orbit");
    });

    test("empty inputs → defaults to Orbit", () => {
      expect(inferStructureType({})).toBe("Orbit");
    });

    test("undefined call → defaults to Orbit", () => {
      expect(inferStructureType()).toBe("Orbit");
    });

    test("null CL estimate → still evaluates correctly", () => {
      const result = inferStructureType({
        orbit_pattern: "same ceiling every time",
        CL_estimate: null,
      });
      expect(result).toBe("Orbit");
    });
  });

  // ── CL estimate as string ─────────────────────────────────────────────────

  describe("CL estimate type handling", () => {
    test("CL as numeric string < 1.5 + self-blame → SWWM", () => {
      expect(
        inferStructureType({
          orbit_pattern: "never enough → collapse → blame myself",
          contradiction_rate: "low",
          CL_estimate: "1.3",
        })
      ).toBe("Something's Wrong With Me");
    });

    test("CL as numeric string >= 1.5 with self-blame, low contradiction → not SWWM", () => {
      const result = inferStructureType({
        orbit_pattern: "shame → push harder",
        contradiction_rate: "low",
        CL_estimate: "2.0",
      });
      expect(result).not.toBe("Something's Wrong With Me");
    });
  });
});
