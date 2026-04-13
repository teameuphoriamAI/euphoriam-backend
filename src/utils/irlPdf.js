/**
 * Invisible Red Line (IRL) report PDF — PDFKit template and markdown cleanup.
 * Kept separate from diagnosticPdf.js (full diagnostic PDF path).
 */

const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
require("dotenv").config();
const axios = require("axios");
const {
  IRL_REPORT_SUBTITLE_V22,
  IRL_PDF_SNAPSHOT_CARD_HEADING,
} = require("../constants/irlBranding");

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

// ─────────────────────────────────────────────────────────────────────────────
// IRL REPORT PDF GENERATOR
// ─────────────────────────────────────────────────────────────────────────────

const IRL_UNICODE_ASTERISK = /[\u2217\u204E\u066D\u273B\u29EB\uFE61\uFF0A]/g;
const IRL_MD_DASH_OR_RULE_RUN = /[-–—―‾﹘﹣－━─═┄┅_\u2500-\u257F]{3,}/g;

const preNormalizeIrlReportSource = (raw) =>
  String(raw || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n")
    .replace(/[\u200B-\u200D\uFEFF\u2060]/g, "")
    .replace(IRL_UNICODE_ASTERISK, "*");

const isIrlDecorativeDividerLine = (trimmed) => {
  const t = trimmed.trim();
  if (t.length < 3) return false;
  const noSpace = t.replace(/\s/g, "");
  if (noSpace.length < 3) return false;
  return /^[.\-–—―═_*‧·•⁃‧┄┅\u2500-\u257F]+$/u.test(noSpace);
};

const cleanIrlPlainFragment = (s) => {
  if (!s) return "";
  return s
    .replace(/#{1,6}\s*/g, "")
    .replace(/`+/g, "")
    .replace(IRL_MD_DASH_OR_RULE_RUN, " ")
    .replace(/\*{3,}/g, " ")
    .replace(/\*{1,2}/g, "")
    .replace(/_{3,}/g, " ")
    .replace(/_{2,}/g, "")
    .replace(/_{1,2}([^_\s][^_]*)_{1,2}/g, "$1")
    .replace(/^\s*[-–—]{2,}\s*$/gm, "")
    .replace(/\s[-–—]{3,}\s/g, " ")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
};

const stripResidualIrlMdForPdf = (text) => {
  if (!text) return "";
  return text
    .replace(IRL_MD_DASH_OR_RULE_RUN, " ")
    .replace(/\*{2,}/g, "")
    .replace(/_{2,}/g, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
};

const extractIrlBoldSegments = (line) => {
  if (!line || typeof line !== "string") return [{ bold: false, text: "" }];
  let s = line
    .replace(/\r/g, "")
    .replace(IRL_UNICODE_ASTERISK, "*")
    .replace(/__([^_]+)__/g, "**$1**");
  const segments = [];
  const re = /\*\*([\s\S]*?)\*\*/g;
  let last = 0;
  let m;
  while ((m = re.exec(s)) !== null) {
    if (m.index > last) {
      const plain = cleanIrlPlainFragment(s.slice(last, m.index));
      if (plain.length) segments.push({ bold: false, text: plain });
    }
    const inner = cleanIrlPlainFragment(m[1]);
    if (inner.length) segments.push({ bold: true, text: inner });
    last = m.index + m[0].length;
  }
  if (last < s.length) {
    const plain = cleanIrlPlainFragment(s.slice(last));
    if (plain.length) segments.push({ bold: false, text: plain });
  }
  if (segments.length === 0) {
    const fallback = cleanIrlPlainFragment(s);
    return [{ bold: false, text: fallback || "" }];
  }
  return segments;
};

const writeIrlMixedParagraph = (doc, line, { pageWidth, fontSize, color }) => {
  const segments = extractIrlBoldSegments(line);
  const nonEmpty = segments
    .map((seg) => ({ ...seg, text: stripResidualIrlMdForPdf(seg.text) }))
    .filter((s) => s.text && s.text.length > 0);
  if (nonEmpty.length === 0) return;
  if (nonEmpty.length === 1) {
    doc
      .font(nonEmpty[0].bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(fontSize)
      .fillColor(color)
      .text(nonEmpty[0].text, { width: pageWidth, lineGap: 3 });
    return;
  }
  for (let i = 0; i < nonEmpty.length; i++) {
    doc
      .font(nonEmpty[i].bold ? "Helvetica-Bold" : "Helvetica")
      .fontSize(fontSize)
      .fillColor(color);
    doc.text(nonEmpty[i].text, {
      width: pageWidth,
      continued: i < nonEmpty.length - 1,
      lineGap: 3,
    });
  }
};

const cleanIrlSectionHeadingForPdf = (heading) => {
  if (!heading) return "";
  const base = heading.replace(/^#{1,6}\s+/, "").trim();
  const cleaned = cleanIrlPlainFragment(base);
  return cleaned || stripResidualIrlMdForPdf(base);
};

const truncatePlainPdfLine = (value, max = 320) => {
  const t = String(value || "").trim();
  if (!t) return "";
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
};

/**
 * Plain-English PDF snapshot (v2.2 §3 alignment) — no EO, CL, vortex IDs, or lack-channel codes.
 */
const buildPlainEnglishIrlPdfSnapshotLines = (dp = {}, cp = {}) => {
  const lines = [];
  const add = (label, value) => {
    const v = truncatePlainPdfLine(value);
    if (v) lines.push(`${label}: ${v}`);
  };
  add("Primary life area", dp.domain_primary);
  add("Outcome you're chasing", dp.desired_outcome);
  add("How this pattern tends to show up", dp.structure_type);
  add("The loop you describe", dp.current_loop || dp.orbit_pattern);
  if (cp.red_barrier_sentence) add("The line you keep hitting", cp.red_barrier_sentence);
  else if (cp.name) add("Working label", cp.name);
  return lines;
};

const normalizeIrlReportTextForPdf = (reportText = "") => {
  const lines = preNormalizeIrlReportSource(reportText).split("\n");
  const out = [];
  let lastWasBlank = false;

  for (let rawLine of lines) {
    let line = rawLine.trimEnd();

    const t = line.trim();
    if (isIrlDecorativeDividerLine(t)) continue;

    if (/^[-*_][-_*\s]*$/.test(t) && t.replace(/\s/g, "").length >= 3 && /^[-_*]+$/.test(t.replace(/\s/g, ""))) {
      continue;
    }
    if (/^[-–—\s]{3,}$/.test(t)) continue;

    if (/^--\s*\d+\s+of\s+\d+\s*--$/i.test(t)) continue;

    line = line.replace(/^#{1,6}\s+/, "");

    const trimmedEarly = line.trim();
    if (/^\d{1,2}\.\s/.test(trimmedEarly)) {
      line = trimmedEarly
        .replace(/^\*{1,3}\s+/, "")
        .replace(/\s\*{1,3}$/, "")
        .trimEnd();
    }

    if (!line.trim()) {
      if (!lastWasBlank) {
        out.push("");
        lastWasBlank = true;
      }
      continue;
    }
    lastWasBlank = false;

    const lower = line.trim().toLowerCase();
    if (
      lower === "invisible red line report" ||
      lower === "your hidden energy structure constraint map" ||
      lower === "your hidden pattern that keeps pulling you off course" ||
      lower.startsWith("subtitle:") ||
      /^invisible red line report$/i.test(line.trim())
    ) {
      continue;
    }

    line = line
      .replace(IRL_MD_DASH_OR_RULE_RUN, " ")
      .replace(/_{3,}/g, " ")
      .replace(/[ \t]{2,}/g, " ")
      .trimEnd();

    if (!line.trim()) {
      if (!lastWasBlank) {
        out.push("");
        lastWasBlank = true;
      }
      continue;
    }
    lastWasBlank = false;

    out.push(line.trimEnd());
  }

  const collapsed = [];
  let blankRun = 0;
  for (const L of out) {
    if (L === "") {
      blankRun++;
      if (blankRun <= 1) collapsed.push("");
    } else {
      blankRun = 0;
      collapsed.push(L);
    }
  }

  return collapsed.join("\n").trim();
};

const parseIrlReportSections = (reportText = "") => {
  const rawLines = reportText.split("\n");
  const sections = [];
  let current = null;

  for (const rawLine of rawLines) {
    const line = rawLine.replace(/\r/g, "").trimEnd();

    const headingMatch = line.match(/^(\d{1,2})\.\s+(.+)/);
    if (headingMatch) {
      if (current) sections.push(current);
      current = { heading: line.trim(), lines: [] };
      continue;
    }

    if (!current) {
      current = { heading: null, lines: [] };
    }

    if (!line.trim()) {
      if (current.lines.length > 0 && current.lines.at(-1)?.text !== "") {
        current.lines.push({ type: "spacer", text: "" });
      }
      continue;
    }

    if (line.trimStart().startsWith("888")) {
      current.lines.push({ type: "marker", text: line.trim() });
    } else if (line.startsWith("[") && line.includes("]")) {
      current.lines.push({ type: "cta", text: line.trim().replace(/^\[|\]$/g, "") });
    } else {
      current.lines.push({ type: "body", text: line.trim() });
    }
  }

  if (current) sections.push(current);
  return sections;
};

/**
 * Generate a PDF for an Invisible Red Line Report diagnostic.
 */
const generateIrlReportPdf = async (diagnostic) =>
  new Promise(async (resolve, reject) => {
    try {
      const outputDir = path.join(__dirname, "..", "..", "reports", "diagnostics");
      ensureDir(outputDir);
      const filePath = path.join(outputDir, `irl-${diagnostic.id || Date.now()}.pdf`);

      const data = diagnostic.data || {};
      const profile = data.profile || {};
      const irlReport = data.irlReport || data.aiReport || "";
      const structuredPacket = data.structuredPacket || {};
      const dp = structuredPacket.diagnostic_packet || {};
      const cp = structuredPacket.constraint_packet || {};
      const userName = profile.name || profile.email?.split("@")[0] || "User";

      const MARGIN = 50;
      const PURPLE = "#7c3aed";
      const LIGHT_PURPLE = "#f5f0ff";
      const DARK = "#1a1a1a";
      const BODY = "#333333";
      const MUTED = "#666666";
      const MARKER_BG = "#f9f4ff";
      const MARKER_BORDER = "#9b59b6";

      const doc = new PDFDocument({ margin: MARGIN, size: "A4" });
      const stream = fs.createWriteStream(filePath);
      stream.on("finish", () => resolve(filePath));
      stream.on("error", reject);
      doc.pipe(stream);

      const pageWidth = doc.page.width - MARGIN * 2;

      try {
        const logoEnv = process.env.LOGO_URL;
        const localLogoPath = path.join(__dirname, "..", "assets", "logo.png");
        let logoBuffer = null;
        if (logoEnv?.startsWith("http")) {
          try {
            const r = await axios.get(logoEnv, { responseType: "arraybuffer" });
            logoBuffer = Buffer.from(r.data, "binary");
          } catch {}
        } else if (logoEnv && fs.existsSync(logoEnv)) {
          logoBuffer = logoEnv;
        }
        if (!logoBuffer && fs.existsSync(localLogoPath)) logoBuffer = localLogoPath;
        if (logoBuffer) {
          doc.image(logoBuffer, doc.page.width / 2 - 25, MARGIN, { width: 50 });
          doc.moveDown(3.5);
        } else {
          doc.moveDown(2);
        }
      } catch {}

      doc
        .fontSize(9)
        .fillColor(PURPLE)
        .font("Helvetica-Bold")
        .text("EUPHORIAM AI", { align: "center", width: pageWidth });

      doc.moveDown(0.3);
      doc
        .fontSize(22)
        .fillColor(DARK)
        .font("Helvetica-Bold")
        .text("INVISIBLE RED LINE REPORT", { align: "center", width: pageWidth });

      doc.moveDown(0.3);
      doc
        .fontSize(12)
        .fillColor(MUTED)
        .font("Helvetica")
        .text(IRL_REPORT_SUBTITLE_V22, { align: "center", width: pageWidth });

      doc.moveDown(0.5);
      doc
        .fontSize(10)
        .fillColor(MUTED)
        .font("Helvetica")
        .text(
          `Prepared for: ${userName}  ·  ${new Date().toLocaleDateString("en-AU", { day: "numeric", month: "long", year: "numeric" })}`,
          { align: "center", width: pageWidth },
        );

      doc.moveDown(1.2);

      doc
        .moveTo(MARGIN, doc.y)
        .lineTo(MARGIN + pageWidth, doc.y)
        .strokeColor(PURPLE)
        .lineWidth(2)
        .stroke();
      doc.moveDown(1.2);

      const snapshotLines = buildPlainEnglishIrlPdfSnapshotLines(dp, cp);
      if (snapshotLines.length > 0) {
        const cardX = MARGIN;
        const cardY = doc.y;
        const cardW = pageWidth;
        const lineH = 16;
        const cardH = 20 + snapshotLines.length * lineH + 20;

        doc
          .roundedRect(cardX, cardY, cardW, cardH, 6)
          .fillAndStroke(LIGHT_PURPLE, PURPLE);

        doc.y = cardY + 16;
        doc
          .font("Helvetica-Bold")
          .fontSize(9)
          .fillColor(PURPLE)
          .text(IRL_PDF_SNAPSHOT_CARD_HEADING, { indent: 14, width: cardW - 28 });

        doc.moveDown(0.4);
        snapshotLines.forEach((line) => {
          doc
            .font("Helvetica")
            .fontSize(10)
            .fillColor(DARK)
            .text(line, { indent: 14, width: cardW - 28, lineGap: 2 });
        });

        doc.y = cardY + cardH + 16;
      }

      const cleanedReport = normalizeIrlReportTextForPdf(irlReport);
      const sections = parseIrlReportSections(cleanedReport);

      for (const section of sections) {
        if (doc.y > doc.page.height - doc.page.margins.bottom - 80) {
          doc.addPage();
        }

        if (section.heading) {
          doc.moveDown(0.8);
          doc
            .font("Helvetica-Bold")
            .fontSize(13)
            .fillColor(PURPLE)
            .text(cleanIrlSectionHeadingForPdf(section.heading), { width: pageWidth, lineGap: 3 });
          doc.moveDown(0.3);
        }

        for (const entry of section.lines) {
          if (entry.type === "spacer") {
            doc.moveDown(0.4);
            continue;
          }

          if (entry.type === "cta") {
            doc.moveDown(0.8);
            const ctaH = 36;
            const pageBottom = doc.page.height - doc.page.margins.bottom;
            if (doc.y + ctaH + 12 > pageBottom) {
              doc.addPage();
            }
            const ctaY = doc.y;
            doc
              .roundedRect(MARGIN, ctaY, pageWidth, ctaH, 6)
              .fillAndStroke(PURPLE, PURPLE);
            doc
              .font("Helvetica-Bold")
              .fontSize(13)
              .fillColor("#ffffff")
              .text(stripResidualIrlMdForPdf(cleanIrlPlainFragment(entry.text)), MARGIN, ctaY + 10, {
                width: pageWidth,
                align: "center",
              });
            doc.y = ctaY + ctaH + 12;
            continue;
          }

          if (entry.type === "marker") {
            const raw = entry.text.replace(/^888\s*/, "").trim();
            const innerW = pageWidth - 14;
            const measureText = raw.replace(/\*\*/g, "");
            doc.font("Helvetica-Bold").fontSize(10.5);
            const textBlockH = doc.heightOfString(measureText, {
              width: innerW,
              lineGap: 2,
            });
            const boxH = Math.max(28, textBlockH + 14);

            const pageBottom = doc.page.height - doc.page.margins.bottom;
            if (doc.y + boxH + 6 > pageBottom) {
              doc.addPage();
            }

            const lineY = doc.y;

            doc
              .rect(MARGIN, lineY, pageWidth, boxH)
              .fillColor(MARKER_BG)
              .fill();

            doc
              .moveTo(MARGIN, lineY)
              .lineTo(MARGIN, lineY + boxH)
              .strokeColor(MARKER_BORDER)
              .lineWidth(3)
              .stroke();

            doc.x = MARGIN + 10;
            doc.y = lineY + 7;
            writeIrlMixedParagraph(doc, raw, {
              pageWidth: innerW,
              fontSize: 10.5,
              color: DARK,
            });
            doc.x = MARGIN;
            doc.y = lineY + boxH + 6;
            continue;
          }

          writeIrlMixedParagraph(doc, entry.text, {
            pageWidth,
            fontSize: 11,
            color: BODY,
          });
          doc.x = MARGIN;
        }
      }

      doc.moveDown(1.5);
      doc
        .moveTo(MARGIN, doc.y)
        .lineTo(MARGIN + pageWidth, doc.y)
        .strokeColor("#dddddd")
        .lineWidth(1)
        .stroke();
      doc.moveDown(0.6);
      doc
        .font("Helvetica")
        .fontSize(9)
        .fillColor(MUTED)
        .text(
          "Euphoriam AI · This report is generated using AI-assisted analysis and is for informational purposes.",
          { align: "center", width: pageWidth },
        );

      doc.end();
    } catch (err) {
      reject(err);
    }
  });

module.exports = {
  generateIrlReportPdf,
  normalizeIrlReportTextForPdf,
  buildPlainEnglishIrlPdfSnapshotLines,
};
