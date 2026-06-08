const { Diagnostic } = require("../models/diagnosticModel");
const { generateFullDiagnosticReport } = require("./euphoriamChatbot");
const { generateDiagnosticPdf } = require("../utils/diagnosticPdf");
const { uploadBufferToSupabase } = require("../utils/storage");
const { sendEmail } = require("../utils/email");
const { diagnosticReportEmail } = require("../utils/emailTemplate/initialDignosticReport");
const { enrichProgressMetricsFromMap } = require("./stage1ProgressMetrics");
const {
  normalizeDiagnosticMetrics,
  inferClLevel,
} = require("./stage1StructuralMap");
const fs = require("fs").promises;

/**
 * Generate and persist the full Phase C diagnostic report after Map Resistance finalize.
 */
const generateAndPersistMapResistanceReport = async ({
  user,
  domain,
  transcript = [],
  activeGoalContext = {},
  introText = "",
  structure = {},
  sendEmail = true,
}) => {
  const userName = user?.name || user?.email?.split("@")[0] || "User";
  const email = user?.email;

  const { reportText, metrics, completeness } = await generateFullDiagnosticReport({
    transcript,
    introPageText: introText,
    activeGoalContext,
    userName,
    structureHints: {
      signature_id: structure.signature_id || null,
      EO: structure.EO || null,
      lack_channel: structure.lack_channel || null,
      avoid_type: structure.avoid_type || null,
      orbit_pattern: structure.orbit_pattern || null,
      protector_rule: structure.protector_rule || null,
      failure_strategy: structure.failure_strategy || null,
      success_strategy: structure.success_strategy || null,
    },
  });

  if (!reportText || reportText.length < 200) {
    throw new Error("Report generation returned empty or too-short content");
  }

  const clLevel = inferClLevel(structure);
  const normalizedMetrics = normalizeDiagnosticMetrics({
    ...metrics,
    consciousnessLevel:
      metrics.consciousnessLevel ??
      (clLevel != null ? clLevel : undefined),
  });

  let diagnostic = null;
  let pdfUrl = null;
  if (email) {
    diagnostic = await Diagnostic.findOne({ where: { email } });
    const payload = {
      userId: user?.id || null,
      email,
      title: `Map Resistance — ${domain} — ${userName}`,
      data: {
        diagnosticVersion: 3,
        generatedAt: new Date(),
        profile: { name: userName, email },
        metrics: normalizedMetrics,
        intakeTranscript: transcript,
        aiReport: reportText,
        map_resistance_domain: domain,
        active_goal_context: activeGoalContext,
        structure_snapshot: {
          signature_id: structure.signature_id || null,
          EO: structure.EO || null,
          lack_channel: structure.lack_channel || null,
          avoid_type: structure.avoid_type || null,
          orbit_pattern: structure.orbit_pattern || null,
          cl_level: clLevel,
          consciousnessLevel: normalizedMetrics.consciousnessLevel ?? null,
        },
      },
    };

    if (diagnostic) {
      diagnostic = await diagnostic.update(payload);
    } else {
      diagnostic = await Diagnostic.create(payload);
    }

    try {
      await diagnostic.reload();
      const pdfPath = await generateDiagnosticPdf(diagnostic);
      if (pdfPath) {
        const buffer = await fs.readFile(pdfPath);
        const pdfVersion = Date.now();
        const objectPath = `diagnostics/diagnostic-${diagnostic.id}-${pdfVersion}.pdf`;
        const upload = await uploadBufferToSupabase({
          buffer,
          objectPath,
          contentType: "application/pdf",
        });
        const versionedUrl = upload.url
          ? `${upload.url}${upload.url.includes("?") ? "&" : "?"}v=${pdfVersion}`
          : null;
        await diagnostic.update({
          pdfUrl: versionedUrl,
          data: {
            ...diagnostic.data,
            pdf: { ...upload, url: versionedUrl, version: pdfVersion },
            pdfUrls: versionedUrl ? [versionedUrl] : [],
          },
        });
        await diagnostic.reload();
        pdfUrl = diagnostic.pdfUrl || upload.url || null;
        if (sendEmail) {
          try {
            await sendEmail(
              email,
              "Your Map Resistance Report – Euphoriam AI",
              diagnosticReportEmail(userName),
              pdfPath,
            );
          } catch (emailErr) {
            console.warn(
              "[stage1MapResistanceReport] Email failed:",
              emailErr.message,
            );
          }
        }
      }
    } catch (pdfErr) {
      console.warn("[stage1MapResistanceReport] PDF failed:", pdfErr.message);
    }
  }

  const progressMetrics = enrichProgressMetricsFromMap(structure, normalizedMetrics);

  return {
    reportText,
    metrics: normalizedMetrics,
    progressMetrics,
    completeness,
    diagnosticId: diagnostic?.id || null,
    pdfUrl: pdfUrl
      ? `${pdfUrl}${pdfUrl.includes("?") ? "&" : "?"}v=${Date.now()}`
      : null,
  };
};

module.exports = {
  generateAndPersistMapResistanceReport,
};
