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
  const filled = Math.round((v / 100) * 12);
  const empty = 12 - filled;
  return `${"#".repeat(filled)}${".".repeat(empty)} ${v}%`;
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

const isAllCapsHeader = (line) =>
  /^[A-Z0-9][A-Z0-9\s/&()'".:-]{6,}$/.test(line) &&
  line === line.toUpperCase();

const renderStyledReport = (doc, text) => {
  const lines = String(text || "").split(/\r?\n/);

  doc.font("Helvetica").fontSize(11);
  doc.fillColor("#111111");

  for (const rawLine of lines) {
    const line = rawLine.trimEnd();

    if (!line.trim()) {
      doc.moveDown(0.8);
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
      const outputDir = path.join(__dirname, "..", "..", "reports", "diagnostics");
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

        // Exact template validation gate
        if (!aiReport.startsWith("----------------------------------------")) {
          const head = aiReport.slice(0, 300);
          const err = new Error(
            `aiReport does not start with divider line. First 300 chars:\n${head}`
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
        doc.text(`Client: ${profile.name || "N/A"} (${profile.email || "N/A"})`);
        doc.text(`User ID: ${diagnostic.userId || "N/A"}`);
        doc.moveDown(0.6);
        doc.text(`Customer ID: ${data.customerId || "N/A"}`);
        doc.text(`Site ID: ${data.siteId || "N/A"}`);
        doc.text(`Kajabi Contact ID: ${data.rawSource?.kajabiContactId ?? "N/A"}`);
        doc.text(`Kajabi Customer ID: ${data.rawSource?.kajabiCustomerId ?? "N/A"}`);

        doc.end();
        return;
      }

      const reportTitle =
        aiReport?.headline?.title || aiReport?.headline || "Euphoriam Diagnostic Report";
      doc.fontSize(20).text(reportTitle, { align: "center" });
      doc.moveDown();
      doc.fontSize(12).text(`Title: ${diagnostic.title || "Diagnostic"}`);
      doc.text(`Generated At: ${new Date().toLocaleString()}`);
      doc.text(`Client: ${profile.name || "N/A"} (${profile.email || "N/A"})`);
      doc.text(`User ID: ${diagnostic.userId || "N/A"}`);

      const isV2 = aiReport?.meta?.version === 2;

      if (!isV2) {
        addSection(doc, "Summary", [aiReport.summary || "No summary provided."]);
        addSection(doc, "Readiness Stage", [
          aiReport.readinessStage || "Not specified",
          aiReport.productGuidance ? `Guidance: ${aiReport.productGuidance}` : null,
        ].filter(Boolean));

        addList(doc, "Strengths", aiReport.strengths);
        addList(doc, "Current Challenges", aiReport.currentChallenges);
        addList(doc, "Recommended Focus", aiReport.recommendedFocus);
        addList(doc, "Next Steps", aiReport.nextSteps);
      } else {
        const before = aiReport.beforeYouRead || {};
        addSection(doc, before.title || "Before You Read", before.lines || []);

        const facts = aiReport.facts || {};
        addSection(doc, "Facts (from your account)", [
          facts.memberSince ? `Member since: ${facts.memberSince}` : null,
          `Sign-ins: ${facts.signInCount ?? profile.signInCount ?? 0}`,
          `Net revenue: ${facts.netRevenue ?? profile.netRevenue ?? 0}`,
        ].filter(Boolean));

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
            const price = o.price !== undefined && o.price !== null ? ` — ${o.price}` : "";
            return `${title}${price}`;
          })
        );

        const courses = facts.courses || metrics.assessments || {};
        addSection(doc, "Course Assessments", [
          `Courses: ${courses.coursesCount ?? 0}`,
          `Assessments: total=${courses.totalAssessments ?? 0}, completed=${courses.completed ?? 0}, pending=${courses.pending ?? 0}`,
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

        addSection(doc, "Metrics Gauge", [
          `QGC Activation: ${renderGauge(gauge.qgcActivation)}`,
          `Consciousness Level: ${gauge.consciousnessLevel ?? "N/A"}`,
          `Gravity: ${renderGauge(gauge.gravity)}`,
          `Signal Coherence: ${renderGauge(gauge.signalCoherence)}`,
          `Signal Output: ${renderGauge(gauge.signalOutput)}`,
        ]);

        const sections = Array.isArray(aiReport.sections) ? aiReport.sections : [];
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
        addList(doc, finalSummary.title || "Final Summary", finalSummary.bullets || []);
      }

      addSection(doc, "Products", (data.products || []).map((p) => {
        const title = p.title || p.id || "Product";
        const type = p.type ? ` (${p.type})` : "";
        return `${title}${type}`;
      }));

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
        `Kajabi Contact ID: ${
          data.rawSource?.kajabiContactId ?? "N/A"
        }`,
        `Site ID: ${data.siteId || "N/A"}`,
      ]);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });

module.exports = { generateDiagnosticPdf };


