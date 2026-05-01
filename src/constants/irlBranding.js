"use strict";

/**
 * v2.2 customer-facing IRL strings (PDF cover, web, emails — keep in sync with
 * `docs/prompt-update-v2.md` and `euphoriamAi-website/lib/irl-branding.ts`).
 */

/** Sentence-case product name shown to users (emails, UI copy, diagnostic titles). */
const IRL_REPORT_PUBLIC_TITLE = "Your Hidden Structure Map";

/** All-caps line on the PDF cover. */
const IRL_REPORT_PUBLIC_TITLE_PDF = "YOUR HIDDEN STRUCTURE MAP";

const IRL_REPORT_SUBTITLE_V22 =
  "Your Hidden Pattern That Keeps Pulling You Off Course";

/** PDF pre-body snapshot card — plain English only; no raw EO / CL / signature codes. */
const IRL_PDF_SNAPSHOT_CARD_HEADING = "YOUR PATTERN AT A GLANCE";

module.exports = {
  IRL_REPORT_PUBLIC_TITLE,
  IRL_REPORT_PUBLIC_TITLE_PDF,
  IRL_REPORT_SUBTITLE_V22,
  IRL_PDF_SNAPSHOT_CARD_HEADING,
};
