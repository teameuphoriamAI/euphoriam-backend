const {
  buildBrainPromptDocuments,
  classifySection,
  extractSignatureIds,
  retrieveDeterministicChunks,
  splitIntoSections,
} = require("../helpers/brainPromptChunking");

describe("brainPromptChunking", () => {
  test("extractSignatureIds finds valid vortex signature", () => {
    expect(extractSignatureIds("Member shows NE+S+R pattern when stressed")).toEqual(["NE+S+R"]);
  });

  test("classifySection detects rep library and uc routing", () => {
    expect(classifySection("REP LIBRARY", "green rep steps")).toBe("rep_library");
    expect(classifySection("UC ROUTING", "under contract paths")).toBe("uc_routing");
  });

  test("splitIntoSections splits on equals headers", () => {
    const text = [
      "================================================================================",
      "SIGNATURE → BEHAVIOUR LIBRARY (Internal)",
      "================================================================================",
      "NE+S+R hypervigilant behaviour",
      "",
      "================================================================================",
      "REP LIBRARY",
      "================================================================================",
      "Clarity rep example",
    ].join("\n");

    const sections = splitIntoSections(text);
    expect(sections.length).toBeGreaterThanOrEqual(2);
    const combined = sections.map((s) => `${s.title}\n${s.body}`).join("\n");
    expect(combined).toMatch(/REP LIBRARY/i);
    expect(combined).toMatch(/NE\+S\+R/);
  });

  test("buildBrainPromptDocuments tags signature_id on single-signature section", () => {
    const docs = buildBrainPromptDocuments({
      content: "NE+S+R: hypervigilant to judgement, social masking when visibility rises.",
      promptType: "Brain Prompt",
    });
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.some((d) => d.metadata.signature_id === "NE+S+R")).toBe(true);
    expect(docs.every((d) => d.metadata.source === "brain_prompt")).toBe(true);
  });

  test("buildSignatureCatalogDocuments tags all 48 signatures", () => {
    const { buildSignatureCatalogDocuments } = require("../helpers/brainPromptChunking");
    const docs = buildSignatureCatalogDocuments({ promptType: "Brain Prompt" });
    expect(docs.length).toBe(48);
    expect(docs.every((d) => d.metadata.signature_id)).toBe(true);
    expect(docs.some((d) => d.metadata.signature_id === "NE+S+R")).toBe(true);
  });
});

describe("brainPromptRag deterministic retrieval", () => {
  test("retrieveDeterministicChunks includes baseline and signature blocks", () => {
    const brainDocs = [
      {
        id: 1,
        title: "UC",
        chunk: "uc routing",
        metadata: { source: "brain_prompt", section: "uc_routing" },
      },
      {
        id: 2,
        title: "Sig",
        chunk: "NE+S+R detail",
        metadata: { source: "brain_prompt", section: "general", signature_id: "NE+S+R" },
      },
      {
        id: 3,
        title: "Other",
        chunk: "NC+C+F detail",
        metadata: { source: "brain_prompt", section: "general", signature_id: "NC+C+F" },
      },
    ];

    const picked = retrieveDeterministicChunks(brainDocs, "NE+S+R");
    expect(picked.map((p) => p.id)).toEqual([1, 2]);
  });
});
