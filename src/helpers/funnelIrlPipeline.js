const { extractStructuredPacket } = require("./structuredPacketExtractor");
const { generateInvisibleRedLineReport } = require("./irlReportGenerator");
const { sanitizeUserFacingReportText } = require("./userFacingReportSanitizer");

const defaultOfferConfig = () => ({
  uc_offer_name: process.env.UC_OFFER_NAME || "Unlimited Creator",
  uc_offer_price_string: process.env.UC_OFFER_PRICE || null,
  include_price_compare: process.env.UC_INCLUDE_PRICE_COMPARE === "true",
  include_button_cta: process.env.UC_INCLUDE_BUTTON_CTA !== "false",
  cta_text: process.env.UC_CTA_TEXT || "Upgrade for Full Access",
});

const defaultFreeAccessFlags = () => ({
  UC: false,
  CreatorClub: false,
  ChangingRealities: false,
  LiveCalls: false,
  Mastery: false,
});

/**
 * Free funnel finalize: extract structure from Q1–Q25 transcript, then generate IRL report.
 */
const generateFunnelIrlReport = async ({ transcript = [], userName = "User" }) => {
  const structuredPacket = await extractStructuredPacket({
    reportText: "",
    transcript,
  });

  const firstName = String(userName || "User").trim().split(/\s+/)[0] || "User";

  const { reportText: rawReportText, wordCount, irlRetryUsed } =
    await generateInvisibleRedLineReport({
      user: { first_name: firstName, name: userName, timezone: null },
      diagnostic_packet: structuredPacket.diagnostic_packet,
      constraint_packet: structuredPacket.constraint_packet,
      optional_inputs: structuredPacket.optional_inputs,
      access_flags: defaultFreeAccessFlags(),
      offer_config: defaultOfferConfig(),
    });

  const reportText = sanitizeUserFacingReportText(rawReportText);

  return {
    reportText,
    structuredPacket,
    wordCount,
    irlRetryUsed,
    metrics: {},
  };
};

module.exports = {
  generateFunnelIrlReport,
  defaultOfferConfig,
  defaultFreeAccessFlags,
};
