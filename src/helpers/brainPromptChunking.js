const { generateVortexSignatures } = require("../utils/euphoriamMatrix");

const SIGNATURE_ID_PATTERN = /\b(NE|NC|NS|PL|CD|NON|NOV|NOH)\+(C|S|P)\+(F|R)\b/g;

const ALL_SIGNATURE_IDS = new Set(
  generateVortexSignatures().map((s) => s.id),
);

const SECTION_HEADER_PATTERN = /^={10,}\s*$|^={10,}\s*.+\s*={10,}$/m;

const classifySection = (title, body) => {
  const t = `${title}\n${body}`.toUpperCase();
  if (/UC\s*ROUT|UNDER.?CONTRACT|UC_ROUTING/.test(t)) return "uc_routing";
  if (/REP\s*LIBRARY|GREEN\s*REP/.test(t)) return "rep_library";
  if (/OPPOSITE\s*MAP|OPPOSITE_MAP/.test(t)) return "opposite_map";
  if (/SIGNATURE.*DICT|SIGNATURE.*BEHAVIOUR|48\s*COMBIN/.test(t)) return "signature_overview";
  if (/SIGNATURE\s*CATALOG/.test(t)) return "signature_catalog";
  return "general";
};

const extractSignatureIds = (text) => {
  const found = new Set();
  const matches = String(text || "").matchAll(SIGNATURE_ID_PATTERN);
  for (const m of matches) {
    if (ALL_SIGNATURE_IDS.has(m[0])) found.add(m[0]);
  }
  return [...found];
};

const chunkText = (text, maxLen = 3500, overlap = 200) => {
  const src = String(text || "").trim();
  if (!src) return [];
  if (src.length <= maxLen) return [src];

  const parts = [];
  let cursor = 0;
  while (cursor < src.length) {
    parts.push(src.slice(cursor, cursor + maxLen).trim());
    cursor += maxLen - overlap;
  }
  return parts.filter(Boolean);
};

const splitIntoSections = (content) => {
  const text = String(content || "").trim();
  if (!text) return [];

  const blocks = text.split(/\n(?=={10,})/);
  const sections = [];

  for (const block of blocks) {
    const trimmed = block.trim();
    if (!trimmed) continue;

    const lines = trimmed.split("\n");
    let title = "General";
    let bodyStart = 0;

    if (SECTION_HEADER_PATTERN.test(lines[0] || "")) {
      title = lines[0].replace(/=+/g, "").trim() || "General";
      bodyStart = 1;
      while (bodyStart < lines.length && /^=+$/.test(lines[bodyStart].trim())) {
        bodyStart += 1;
      }
    } else if (/^[A-Z][A-Z0-9 /→\-–—().]+$/.test((lines[0] || "").trim()) && lines[0].length < 120) {
      title = lines[0].trim();
      bodyStart = 1;
    }

    const body = lines.slice(bodyStart).join("\n").trim();
    if (!body && !title) continue;

    sections.push({ title, body: body || trimmed });
  }

  if (!sections.length) {
    sections.push({ title: "Brain Prompt", body: text });
  }

  return sections;
};

const splitBodyBySignatureHeaders = (body) => {
  const lines = String(body || "").split("\n");
  const blocks = [];
  let current = { sigIds: [], lines: [] };

  for (const line of lines) {
    const lineSigs = extractSignatureIds(line);
    const headerSig =
      lineSigs.length === 1 && /^[^\w]*[A-Z]{2,3}\+[A-Z]\+[A-Z]/.test(line.trim())
        ? lineSigs[0]
        : null;
    if (headerSig) {
      if (current.lines.length) blocks.push(current);
      current = { sigIds: [headerSig], lines: [line] };
      continue;
    }
    current.lines.push(line);
    for (const sig of lineSigs) {
      if (!current.sigIds.includes(sig)) current.sigIds.push(sig);
    }
  }
  if (current.lines.length) blocks.push(current);
  return blocks.length > 1 ? blocks : null;
};

/** Canonical 48-signature rows for deterministic hybrid lookup (Brain Prompt text often omits IDs). */
const buildSignatureCatalogDocuments = ({ promptType, version = "1" }) => {
  const signatures = generateVortexSignatures();
  return signatures.map((sig) => {
    const chunk = [
      `${sig.id}: ${sig.failurePattern}`,
      `EO: ${sig.eo?.name || sig.eo?.code || ""}`,
      `Lack: ${sig.lack?.name || sig.lack?.code || ""}`,
      `Avoid: ${sig.avoid?.name || sig.avoid?.code || ""}`,
      sig.oppositeBehavior ? `Opposite behaviour: ${sig.oppositeBehavior}` : null,
    ]
      .filter(Boolean)
      .join("\n");

    return {
      title: `${promptType}: Signature catalog ${sig.id}`,
      chunk,
      metadata: {
        source: "brain_prompt",
        prompt_type: promptType,
        section: "signature_catalog",
        section_title: `Signature ${sig.id}`,
        signature_id: sig.id,
        signature_ids: [sig.id],
        chunk_index: 0,
        version,
      },
    };
  });
};

/**
 * Turn Brain Prompt text into document rows ready for embed + insert.
 */
const buildBrainPromptDocuments = ({ content, promptType, version = "1" }) => {
  const sections = splitIntoSections(content);
  const docs = [];

  for (const section of sections) {
    const sectionType = classifySection(section.title, section.body);
    const signatureBlocks = splitBodyBySignatureHeaders(section.body);
    const bodies = signatureBlocks
      ? signatureBlocks.map((block) => ({
          body: block.lines.join("\n").trim(),
          signatureIds: block.sigIds,
        }))
      : [{ body: section.body, signatureIds: extractSignatureIds(`${section.title}\n${section.body}`) }];

    for (const part of bodies) {
      if (!part.body) continue;
      const subChunks = chunkText(part.body);

      subChunks.forEach((chunk, idx) => {
        const chunkSigs = extractSignatureIds(chunk);
        const sigIds = [
          ...new Set([...(part.signatureIds || []), ...chunkSigs]),
        ].filter((id) => ALL_SIGNATURE_IDS.has(id));

        docs.push({
          title: `${promptType}: ${section.title}${subChunks.length > 1 ? ` [${idx + 1}/${subChunks.length}]` : ""}`,
          chunk,
          metadata: {
            source: "brain_prompt",
            prompt_type: promptType,
            section: sectionType,
            section_title: section.title,
            signature_id: sigIds[0] || null,
            signature_ids: sigIds,
            chunk_index: idx,
            version,
          },
        });
      });
    }
  }

  docs.push(...buildSignatureCatalogDocuments({ promptType, version }));

  return docs;
};

const toBrainChunkResult = (doc, score = 1) => ({
  id: doc.id,
  title: doc.title,
  chunk: doc.chunk,
  metadata: doc.metadata,
  score,
});

const BASELINE_BRAIN_SECTIONS = new Set([
  "uc_routing",
  "rep_library",
  "opposite_map",
  "signature_overview",
]);

const retrieveDeterministicChunks = (brainDocs, signatureId) => {
  const picked = [];
  const seen = new Set();

  const matchesSignature = (doc, sigId) => {
    const meta = doc.metadata || {};
    if (meta.signature_id === sigId) return true;
    if (Array.isArray(meta.signature_ids) && meta.signature_ids.includes(sigId)) {
      return true;
    }
    return false;
  };

  const add = (doc, score) => {
    const key = `${doc.id}`;
    if (seen.has(key)) return;
    seen.add(key);
    picked.push(toBrainChunkResult(doc, score));
  };

  for (const doc of brainDocs) {
    if (BASELINE_BRAIN_SECTIONS.has(doc.metadata?.section)) {
      add(doc, 1);
    }
  }

  if (signatureId) {
    for (const doc of brainDocs) {
      if (matchesSignature(doc, signatureId)) {
        add(doc, 1);
      }
    }
  }

  return picked;
};

module.exports = {
  ALL_SIGNATURE_IDS,
  BASELINE_BRAIN_SECTIONS,
  buildBrainPromptDocuments,
  buildSignatureCatalogDocuments,
  classifySection,
  chunkText,
  extractSignatureIds,
  retrieveDeterministicChunks,
  splitBodyBySignatureHeaders,
  splitIntoSections,
  toBrainChunkResult,
};
