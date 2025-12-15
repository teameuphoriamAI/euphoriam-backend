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

      doc.fontSize(20).text("Diagnostic Report", { align: "center" });
      doc.moveDown();
      doc.fontSize(12).text(`Title: ${diagnostic.title || "Diagnostic"}`);
      doc.text(`Generated At: ${new Date().toLocaleString()}`);
      doc.text(`Client: ${profile.name || "N/A"} (${profile.email || "N/A"})`);
      doc.text(`User ID: ${diagnostic.userId || "N/A"}`);

      addSection(doc, "Summary", [aiReport.summary || "No summary provided."]);
      addSection(doc, "Readiness Stage", [
        aiReport.readinessStage || "Not specified",
        aiReport.productGuidance ? `Guidance: ${aiReport.productGuidance}` : null,
      ].filter(Boolean));

      addList(doc, "Strengths", aiReport.strengths);
      addList(doc, "Current Challenges", aiReport.currentChallenges);
      addList(doc, "Recommended Focus", aiReport.recommendedFocus);
      addList(doc, "Next Steps", aiReport.nextSteps);

      addSection(doc, "Products", (data.products || []).map((p) => {
        const title = p.title || p.id || "Product";
        const type = p.type ? ` (${p.type})` : "";
        return `${title}${type}`;
      }));

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


