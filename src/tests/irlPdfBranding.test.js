const {
  buildPlainEnglishIrlPdfSnapshotLines,
  normalizeIrlReportTextForPdf,
} = require("../utils/irlPdf");
const {
  IRL_REPORT_PUBLIC_TITLE,
  IRL_REPORT_PUBLIC_TITLE_PDF,
  IRL_REPORT_SUBTITLE_V22,
} = require("../constants/irlBranding");

describe("IRL PDF branding (Phase C)", () => {
  test("v2.2 subtitle constant matches spec", () => {
    expect(IRL_REPORT_SUBTITLE_V22).toContain("Hidden Pattern");
    expect(IRL_REPORT_SUBTITLE_V22).not.toMatch(/Energy Structure|Constraint Map/i);
  });

  test("plain-English snapshot never emits raw framework code lines", () => {
    const lines = buildPlainEnglishIrlPdfSnapshotLines(
      {
        domain_primary: "Career",
        EO: "NE",
        lack_channel: "money",
        signature_primary_id: "VORTEX-9",
        CL_estimate: 2.1,
        structure_type: "Orbit",
      },
      { name: "Overwork protector", red_barrier_sentence: null }
    );
    const blob = lines.join("\n");
    expect(blob).toContain("Career");
    expect(blob).toContain("Orbit");
    expect(blob).toContain("Overwork protector");
    expect(blob).not.toContain("NE");
    expect(blob).not.toContain("VORTEX");
    expect(blob).not.toContain("CL ");
    expect(blob).not.toContain("Egoic");
    expect(blob).not.toContain("Lack channel");
  });

  test("normalize strips v1 and v2 cover subtitle echo lines from body", () => {
    const raw = [
      "Invisible Red Line Report",
      IRL_REPORT_PUBLIC_TITLE,
      IRL_REPORT_PUBLIC_TITLE_PDF,
      "Your Hidden Energy Structure Constraint Map",
      "Your Hidden Pattern That Keeps Pulling You Off Course",
      "Subtitle: something",
      "",
      "1. Before you read this",
      "Some body.",
    ].join("\n");
    const out = normalizeIrlReportTextForPdf(raw);
    expect(out).toContain("Before you read this");
    expect(out).not.toMatch(/Energy Structure|Constraint Map/);
    expect(out).not.toContain("Your Hidden Pattern That Keeps Pulling You Off Course");
    expect(out).not.toContain(IRL_REPORT_PUBLIC_TITLE);
    expect(out).not.toContain(IRL_REPORT_PUBLIC_TITLE_PDF);
  });
});
