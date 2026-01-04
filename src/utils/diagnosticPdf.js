const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const addSection = (doc, title, bodyLines) => {
  if (!bodyLines || bodyLines.length === 0) return;
  doc.moveDown(0.6);
  doc.fontSize(13).text(title, { underline: true });
  doc.moveDown(0.2);
  bodyLines.forEach((line) => doc.fontSize(11).text(line));
};

const addList = (doc, title, items) => {
  if (!items || items.length === 0) return;
  doc.moveDown(0.6);
  doc.fontSize(13).text(title, { underline: true });
  doc.moveDown(0.2);
  items.forEach((item) => doc.fontSize(11).text(`• ${item}`));
};

const renderGauge = (value) => {
  const v = Math.max(0, Math.min(100, Number(value || 0)));
  const totalBlocks = 12;
  const filled = Math.round((v / 100) * totalBlocks);
  const empty = totalBlocks - filled;

  const filledBlock = "█".repeat(filled);
  const emptyBlock = "░".repeat(empty); // lighter block
  return `${filledBlock}${emptyBlock} ${v}%`;
};

const drawDivider = (doc) => {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const y = doc.y + 6;
  doc
    .moveTo(left, y)
    .lineTo(right, y)
    .lineWidth(1)
    .strokeColor("#111111")
    .stroke();
  doc.moveDown(1);
};
const drawMetricsTable = (doc, metrics) => {
  const startX = doc.x;
  let y = doc.y;
  const rowHeight = 20;
  const colWidths = [150, 150]; // Adjust as needed

  const tableData = [
    ["Metric", "Value"],
    ["QGC Activation", `${metrics.qgcActivation ?? "N/A"}%`],
    ["Consciousness Level", `${metrics.consciousnessLevel ?? "N/A"}%`],
    ["Gravity", `${metrics.gravity ?? "N/A"}%`],
    ["Signal Coherence", `${metrics.signalCoherence ?? "N/A"}%`],
    ["Signal Output", `${metrics.signalOutput ?? "N/A"}%`],
  ];

  tableData.forEach((row, i) => {
    let x = startX;
    row.forEach((cell, j) => {
      doc.rect(x, y, colWidths[j], rowHeight).stroke(); // Draw border
      doc.text(cell, x + 5, y + 5, { width: colWidths[j] - 10, align: "left" });
      x += colWidths[j];
    });
    y += rowHeight;
  });

  doc.moveDown(2);
};

const drawMetricsInterpretationTable = (doc) => {
  const startX = doc.x;
  let y = doc.y;
  const pageWidth = doc.page.width;
  const pageMargins = doc.page.margins;
  const availableWidth = pageWidth - pageMargins.left - pageMargins.right;
  
  // Column widths for 5 columns
  const colWidths = [
    availableWidth * 0.18, // Metric
    availableWidth * 0.22, // What It Represents
    availableWidth * 0.20, // Low (0-39)
    availableWidth * 0.20, // Mid (40-69)
    availableWidth * 0.20, // High (70-100)
  ];

  const tableData = [
    // Header row
    [
      "Metric",
      "What It Represents",
      "Low (0-39)",
      "Mid (40-69)",
      "High (70-100)",
    ],
    // QGC Activation
    [
      "QGC Activation",
      "Access to your native creation codes",
      "Codes dormant; expression feels blocked",
      "Codes intermittent; talent present, inconsistent",
      "Codes online; expression is potent and clear",
    ],
    // Consciousness Level
    [
      "Consciousness Level",
      "Vantage point of perception and authorship",
      "Reactive/survival-led perception",
      "Mixed perception; oscillates under stress",
      "Author-level perception; stable self-leadership",
    ],
    // Gravity
    [
      "Gravity",
      "Pull of old identity and inherited roles",
      "Low pull; change is easier to sustain",
      "Moderate pull; requires structure to stabilize",
      "Strong pull; loyalty patterns dominate unless addressed",
    ],
    // Signal Coherence
    [
      "Signal Coherence",
      "Alignment between truth, emotion, choice, action",
      "Fragmented signal; mixed outcomes",
      "Partial alignment; results come with effort",
      "Clean alignment; reality responds quickly",
    ],
    // Signal Output
    [
      "Signal Output",
      "Broadcast strength to reality (IP-protected)",
      "Low broadcast; muted impact/traction",
      "Moderate broadcast; traction with consistency",
      "High broadcast; strong impact, visibility, manifestation",
    ],
  ];

  const headerRowHeight = 25;
  const dataRowHeight = 35; // Taller rows for multi-line text

  // Draw header row
  doc.font("Helvetica-Bold").fontSize(9);
  let x = startX;
  tableData[0].forEach((cell, j) => {
    doc.rect(x, y, colWidths[j], headerRowHeight).stroke();
    doc.text(cell, x + 3, y + 5, {
      width: colWidths[j] - 6,
      align: "left",
      lineGap: 1,
    });
    x += colWidths[j];
  });
  y += headerRowHeight;

  // Draw data rows
  doc.font("Helvetica").fontSize(8);
  for (let i = 1; i < tableData.length; i++) {
    const row = tableData[i];
    
    // Check if we need a new page
    const estimatedRowHeight = dataRowHeight;
    if (y + estimatedRowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    
    x = startX;
    
    // Calculate row height based on longest cell content
    let maxLines = 1;
    row.forEach((cell, cellIndex) => {
      // Estimate lines by character count and width
      const cellWidth = colWidths[cellIndex] - 6;
      const estimatedCharsPerLine = Math.floor(cellWidth / 4); // Rough estimate: 4px per char
      const cellLines = Math.ceil(cell.length / estimatedCharsPerLine) || 1;
      maxLines = Math.max(maxLines, cellLines);
    });
    const currentRowHeight = Math.max(dataRowHeight, maxLines * 10 + 10);

    row.forEach((cell, j) => {
      doc.rect(x, y, colWidths[j], currentRowHeight).stroke();
      doc.text(cell, x + 3, y + 5, {
        width: colWidths[j] - 6,
        align: "left",
        lineGap: 1,
      });
      x += colWidths[j];
    });
    y += currentRowHeight;
  }

  doc.moveDown(2);
  doc.font("Helvetica").fontSize(11); // Reset to default font size
};

const isAllCapsHeader = (line) =>
  /^[A-Z0-9][A-Z0-9\s/&()'".:-]{6,}$/.test(line) && line === line.toUpperCase();

const renderStyledReport = (doc, text) => {
  const lines = String(text || "").split(/\r?\n/);

  doc.font("Helvetica").fontSize(11);
  doc.fillColor("#111111");

  let skipUntilNextSection = false;
  let foundMetricsInterpretation = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trimEnd();

    // Check if we've found the Metrics Interpretation Table header
    if (
      /METRICS\s+INTERPRETATION\s+TABLE/i.test(line) ||
      /METRICS INTERPRETATION/i.test(line)
    ) {
      foundMetricsInterpretation = true;
      skipUntilNextSection = true;
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(12).text("METRICS INTERPRETATION TABLE");
      doc.moveDown(0.3);
      drawMetricsInterpretationTable(doc);
      doc.font("Helvetica").fontSize(11); // Reset font
      continue;
    }

    // Skip lines until we hit the next major section (empty line + header, divider, or section marker)
    if (skipUntilNextSection) {
      // Check if we've hit a new section (empty line followed by header, or divider, or section marker)
      if (
        (!line.trim() && i + 1 < lines.length && 
         (isAllCapsHeader(lines[i + 1]?.trim()) || 
          lines[i + 1]?.trim().startsWith("SECTION") ||
          lines[i + 1]?.trim().startsWith("PHASE") ||
          lines[i + 1]?.trim() === "----------------------------------------")) ||
        line === "----------------------------------------" ||
        /^SECTION\s+\d+\s+—\s+/.test(line) ||
        /^PHASE\s+\d+\s+—\s+/.test(line) ||
        (isAllCapsHeader(line) && line !== "METRICS INTERPRETATION TABLE")
      ) {
        skipUntilNextSection = false;
        // Continue processing this line
      } else {
        // Skip this line (it's part of the table text we're replacing)
        continue;
      }
    }

    if (!line.trim()) {
      doc.moveDown(0.8);
      continue;
    }

    // Markdown horizontal rules (---)
    if (/^---+$/.test(line)) {
      doc.moveDown(0.3);
      continue;
    }

    if (line === "----------------------------------------") {
      drawDivider(doc);
      continue;
    }

    // H1: "* ..."
    if (line.startsWith("* ")) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(16).text(line.slice(2));
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.4);
      continue;
    }

    // Markdown headers (##, ###, etc.)
    if (/^#{1,6}\s+/.test(line)) {
      const headerText = line.replace(/^#{1,6}\s+/, "").trim();
      const headerLevel = (line.match(/^#+/)?.[0] || "").length;
      const fontSize = headerLevel === 1 ? 16 : headerLevel === 2 ? 14 : headerLevel === 3 ? 13 : 12;
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(fontSize).text(headerText);
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.2);
      continue;
    }

    // Section headers
    if (/^SECTION\s+\d+\s+—\s+/.test(line)) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(13).text(line);
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.2);
      continue;
    }

    // Phase headers
    if (/^PHASE\s+\d+\s+—\s+/.test(line)) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(12).text(line);
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.2);
      continue;
    }

    // Block headers
    if (line === "EVIDENCE:") {
      doc.font("Helvetica-Bold").fontSize(11).text(line);
      doc.font("Helvetica").fontSize(11);
      continue;
    }

    if (isAllCapsHeader(line)) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(12).text(line);
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.1);
      continue;
    }

    // Bullets: "- ..."
    if (/^\-\s+/.test(line)) {
      doc.text(`• ${line.replace(/^\-\s+/, "")}`, {
        indent: 18,
        lineGap: 2,
      });
      continue;
    }

    // Body
    doc.text(line, { lineGap: 2 });
  }
};

const generateDiagnosticPdf = (diagnostic) =>
  new Promise((resolve, reject) => {
    try {
      const outputDir = path.join(
        __dirname,
        "..",
        "..",
        "reports",
        "diagnostics"
      );
      ensureDir(outputDir);

      const filePath = path.join(
        outputDir,
        `diagnostic-${diagnostic.id || Date.now()}.pdf`
      );

      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);

      stream.on("finish", () => resolve(filePath));
      stream.on("error", reject);

      doc.pipe(stream);

      const data = diagnostic.data || {};
      const profile = data.profile || {};
      const aiReport = data.aiReport || {};
      const metrics = data.metrics || {};

      if (typeof aiReport === "string") {
        console.log("[diagnosticPdf] aiReport typeof:", typeof aiReport);
        console.log("[diagnosticPdf] aiReport head:", aiReport.slice(0, 200));

        // Allow: legacy divider-led reports, intro-led reports, or title pages
        // that contain the intro within the first chunk.
        const trimmed = aiReport.trimStart();
        const startsWithDivider = trimmed.startsWith(
          "----------------------------------------"
        );
        const startsWithIntro = trimmed.startsWith(
          "✨ BEFORE YOU READ THIS DIAGNOSTIC"
        );
        const containsIntroEarly =
          !startsWithIntro &&
          trimmed.slice(0, 500).includes("BEFORE YOU READ THIS DIAGNOSTIC");
        const startsWithTitle = trimmed
          .toUpperCase()
          .startsWith("EUPHORIAM DIAGNOSTIC REPORT");
        const startsWithFullTitle = /^EUPHORIAM.*DIAGNOSTIC REPORT/i.test(
          trimmed
        );
        // Check for markdown format (--- followed by ## header, or just ## header)
        const hasMarkdownHeader = /^---+[\s\n]*##\s*EUPHORIAM.*STRUCTURAL UPDATE REPORT/i.test(
          trimmed
        ) || /^##\s*EUPHORIAM.*STRUCTURAL UPDATE REPORT/i.test(trimmed);
        const startsWithMarkdownHeader = /^#+\s*EUPHORIAM/i.test(trimmed);
        const startsWithMarkdownDivider = /^---+/.test(trimmed);

        if (
          !startsWithDivider &&
          !startsWithIntro &&
          !containsIntroEarly &&
          !startsWithTitle &&
          !startsWithFullTitle &&
          !hasMarkdownHeader &&
          !startsWithMarkdownHeader &&
          !startsWithMarkdownDivider
        ) {
          const head = aiReport.slice(0, 300);
          const err = new Error(
            `aiReport does not start with a recognized header. First 300 chars:\n${head}`
          );
          err.code = "AI_REPORT_TEMPLATE_MISMATCH";
          throw err;
        }

        renderStyledReport(doc, aiReport);

        // Optional metadata on a new page (after the report)
        doc.addPage();
        doc.font("Helvetica-Bold").fontSize(14).text("Diagnostic Metadata");
        doc.moveDown(0.6);
        doc.font("Helvetica").fontSize(11);
        doc.text(`Title: ${diagnostic.title || "Diagnostic"}`);
        doc.text(`Generated At: ${new Date().toLocaleString()}`);
        doc.text(
          `Client: ${profile.name || "N/A"} (${profile.email || "N/A"})`
        );
        doc.text(`User ID: ${diagnostic.userId || "N/A"}`);
        doc.moveDown(0.6);
        doc.text(`Customer ID: ${data.customerId || "N/A"}`);
        doc.text(`Site ID: ${data.siteId || "N/A"}`);
        doc.text(
          `Kajabi Contact ID: ${data.rawSource?.kajabiContactId ?? "N/A"}`
        );
        doc.text(
          `Kajabi Customer ID: ${data.rawSource?.kajabiCustomerId ?? "N/A"}`
        );

        doc.end();
        return;
      }

      const reportTitle =
        aiReport?.headline?.title ||
        aiReport?.headline ||
        "Euphoriam Diagnostic Report";
      doc.fontSize(20).text(reportTitle, { align: "center" });
      doc.moveDown();
      doc.fontSize(12).text(`Title: ${diagnostic.title || "Diagnostic"}`);
      doc.text(`Generated At: ${new Date().toLocaleString()}`);
      doc.text(`Client: ${profile.name || "N/A"} (${profile.email || "N/A"})`);
      doc.text(`User ID: ${diagnostic.userId || "N/A"}`);

      const isV2 = aiReport?.meta?.version === 2;

      if (!isV2) {
        addSection(doc, "Summary", [
          aiReport.summary || "No summary provided.",
        ]);
        addSection(
          doc,
          "Readiness Stage",
          [
            aiReport.readinessStage || "Not specified",
            aiReport.productGuidance
              ? `Guidance: ${aiReport.productGuidance}`
              : null,
          ].filter(Boolean)
        );

        addList(doc, "Strengths", aiReport.strengths);
        addList(doc, "Current Challenges", aiReport.currentChallenges);
        addList(doc, "Recommended Focus", aiReport.recommendedFocus);
        addList(doc, "Next Steps", aiReport.nextSteps);
      } else {
        const before = aiReport.beforeYouRead || {};
        addSection(doc, before.title || "Before You Read", before.lines || []);

        const facts = aiReport.facts || {};
        addSection(
          doc,
          "Facts (from your account)",
          [
            facts.memberSince ? `Member since: ${facts.memberSince}` : null,
            `Sign-ins: ${facts.signInCount ?? profile.signInCount ?? 0}`,
            `Net revenue: ${facts.netRevenue ?? profile.netRevenue ?? 0}`,
          ].filter(Boolean)
        );

        const products = facts.products || data.products || [];
        addSection(
          doc,
          "Products / Access",
          (products || []).map((p) => {
            const title = p.title || p.id || "Product";
            const type = p.type ? ` (${p.type})` : "";
            return `${title}${type}`;
          })
        );

        const offers = facts.offers || data.offers || [];
        addSection(
          doc,
          "Offers",
          (offers || []).map((o) => {
            const title = o.title || "Offer";
            const price =
              o.price !== undefined && o.price !== null ? ` — ${o.price}` : "";
            return `${title}${price}`;
          })
        );

        const courses = facts.courses || metrics.assessments || {};
        addSection(doc, "Course Assessments", [
          `Courses: ${courses.coursesCount ?? 0}`,
          `Assessments: total=${courses.totalAssessments ?? 0}, completed=${
            courses.completed ?? 0
          }, pending=${courses.pending ?? 0}`,
          `Completion: ${courses.completionPercentage ?? 0}%`,
          `Pass rate: ${courses.passRate ?? 0}%`,
        ]);

        const gauge = aiReport.metricsGauge || {
          qgcActivation: metrics.qgcActivation,
          consciousnessLevel: metrics.consciousnessLevel,
          gravity: metrics.gravity,
          signalCoherence: metrics.signalCoherence,
          signalOutput: metrics.signalOutput,
        };

        drawMetricsTable(doc, gauge);
        
        // Add Metrics Interpretation Table
        doc.moveDown(0.5);
        doc.font("Helvetica-Bold").fontSize(12).text("METRICS INTERPRETATION TABLE");
        doc.moveDown(0.3);
        drawMetricsInterpretationTable(doc);

        const sections = Array.isArray(aiReport.sections)
          ? aiReport.sections
          : [];
        for (const s of sections) {
          addSection(doc, s.title || "Section", s.body || []);
          addSection(
            doc,
            "Evidence",
            Array.isArray(s.evidence) ? s.evidence.map((e) => `- ${e}`) : []
          );
        }

        const rec = aiReport.recommendationEngine || {};
        const phases = Array.isArray(rec.phases) ? rec.phases : [];
        for (const p of phases) {
          addList(doc, p.title || "Recommendation Phase", p.items || []);
        }

        const finalSummary = aiReport.finalSummary || {};
        addList(
          doc,
          finalSummary.title || "Final Summary",
          finalSummary.bullets || []
        );
      }

      addSection(
        doc,
        "Products",
        (data.products || []).map((p) => {
          const title = p.title || p.id || "Product";
          const type = p.type ? ` (${p.type})` : "";
          return `${title}${type}`;
        })
      );

      // Back-compat only: older data shape (not used in v2)
      const assessmentProgress = data.assessments?.progress || [];
      if (assessmentProgress.length > 0) {
        addList(
          doc,
          "Assessments",
          assessmentProgress.map((a) => {
            const status = a.status || "pending";
            return `Assessment ${a.assessmentId}: ${status}`;
          })
        );
      }

      addSection(doc, "Raw Source", [
        `Customer ID: ${data.customerId || "N/A"}`,
        `Kajabi Contact ID: ${data.rawSource?.kajabiContactId ?? "N/A"}`,
        `Site ID: ${data.siteId || "N/A"}`,
      ]);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });

module.exports = { generateDiagnosticPdf };
