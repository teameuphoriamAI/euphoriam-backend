/**
 * Exercise the live `invisible_red_line_report` prompt + IRL PDF renderer (no funnel quota).
 *
 * Requires: DATABASE_URL, OPENAI_API_KEY, active IRL prompt row in DB.
 *
 *   node src/scripts/testIrlRedlinePdf.js
 */

const path = require("path");
require("dotenv").config({ path: path.join(__dirname, "../../.env") });

const { generateInvisibleRedLineReport } = require("../helpers/irlReportGenerator");
const { generateIrlReportPdf } = require("../utils/irlPdf");
const { sequelize } = require("../config/sequelize");

const fixturePacket = {
  diagnostic_packet: {
    domain_primary: "Creative business — launching an offer while managing fear of visibility",
    desired_outcome:
      "Consistent revenue without burning out; feel safe being seen while selling.",
    current_loop:
      "Plans intensely, ships small pieces, then pulls back when engagement rises — interprets traction as risk.",
    orbit_pattern: "Approach visibility, spike of activity, withdraw, repeat with a new angle",
    EO: "If I stay small I stay safe; growth means being judged or overwhelmed.",
    lack_channel: "Time feels scarce; energy collapses after public posts or launches.",
    protector_type: "Hyper-vigilance + perfection gate",
    gravity_depth: "Pattern stable ~4 years; worsens under deadlines or comparison.",
    CL_estimate: "1.4",
    CL_confidence: "medium",
    rule_engine:
      "Do enough to look serious, never enough to be fully exposed; correct course at first sign of attention.",
    behaviour_evidence:
      "Drafts pile up; launches slip; celebrates privately then goes quiet when replies arrive.",
    recovery_speed: "Days to weeks — slower if sleep is poor.",
    contradiction_rate: "High — wants growth but shrinks when it appears.",
    signature_confidence: "medium-high",
    signature_primary_id: "visibility_protector",
    signature_secondary_id: "capacity_story",
    predictions:
      "Next launch will spike then taper unless the protector is named and regulated, not overridden.",
    falsifiers:
      "Sustained posting + sales conversations for 21 days without a shame spiral.",
    confirmation_test:
      "One small public commitment weekly for a month with a pre-planned recovery ritual after.",
    structure_type: "Orbit",
    protector_profile: {
      what_it_prevents: "Humiliation, overwhelm, being misunderstood publicly",
      typical_behaviours: ["over-editing", "ghosting after traction", "reframing delay as quality"],
    },
    daily_rep_assigned: {
      name: "Minimum viable visibility",
      steps: ["10-minute ship", "one reply to engagement", "close laptop on timer"],
      win_condition: "Ship exists in public without same-day collapse",
    },
    recommended_resource: "Nervous-system aware launch pacing",
    data_needed_next: "Sleep baseline, actual hours on revenue tasks vs rumination",
  },
  constraint_packet: {
    name: "The visibility ceiling",
    protector_rule: "Do not be fully seen; partial effort keeps you in control.",
    red_barrier_sentence: "If they really saw me, they'd reject the offer.",
    how_it_caps_output: "Caps reach, delays launches, shrinks pricing conversations.",
    good_intent: "Protects from shame spirals and overcommitment.",
    bad_cost: "Revenue plateaus; confidence erodes; proof never compounds.",
    confidence: "high",
    alt_hypothesis: "Capacity is trainable; fear is misread as truth.",
  },
  optional_inputs: {
    top_trigger_example: "A post performed well and inbox filled — went silent for a week.",
    recent_trigger_example: "Scheduled a live, cancelled, blamed tech.",
    abduction_sentence: "The system learned that being seen leads to danger.",
    family_rule_summary: "Don't outshine; keep your head down.",
    main_avoidance_behaviours: ["editing instead of publishing", "research spirals"],
    main_cost_domain: "Revenue and reputation momentum",
  },
};

async function main() {
  if (!process.env.OPENAI_API_KEY) {
    console.error("OPENAI_API_KEY is missing (.env).");
    process.exit(1);
  }
  if (!process.env.DATABASE_URL) {
    console.error("DATABASE_URL is missing (.env).");
    process.exit(1);
  }

  await sequelize.authenticate();

  const offer_config = {
    uc_offer_name: process.env.UC_OFFER_NAME || "Unlimited Creator",
    uc_offer_price_string: process.env.UC_OFFER_PRICE || null,
    include_price_compare: process.env.UC_INCLUDE_PRICE_COMPARE === "true",
    include_button_cta: process.env.UC_INCLUDE_BUTTON_CTA !== "false",
    cta_text: process.env.UC_CTA_TEXT || "Upgrade for Full Access",
  };

  console.log("Generating IRL report (Stage 2, live DB prompt)…");
  const { reportText, wordCount, irlRetryUsed } = await generateInvisibleRedLineReport({
    user: { first_name: "PromptTest", timezone: "Australia/Sydney" },
    diagnostic_packet: fixturePacket.diagnostic_packet,
    constraint_packet: fixturePacket.constraint_packet,
    optional_inputs: fixturePacket.optional_inputs,
    access_flags: {
      UC: false,
      CreatorClub: false,
      ChangingRealities: false,
      LiveCalls: false,
      Mastery: false,
    },
    offer_config,
  });

  console.log(`IRL words: ${wordCount}${irlRetryUsed ? " (after expand retry)" : ""}`);

  const id = `prompt-test-${Date.now()}`;
  const diagnostic = {
    id,
    data: {
      profile: { name: "PromptTest", email: "prompt-test@example.com" },
      irlReport: reportText,
      structuredPacket: {
        diagnostic_packet: fixturePacket.diagnostic_packet,
        constraint_packet: fixturePacket.constraint_packet,
        optional_inputs: fixturePacket.optional_inputs,
      },
      funnelMode: false,
    },
  };

  console.log("Rendering PDF…");
  const pdfPath = await generateIrlReportPdf(diagnostic);
  console.log("Done.");
  console.log(JSON.stringify({ pdfPath, diagnosticId: id, wordCount }, null, 2));

  await sequelize.close();
}

main().catch(async (e) => {
  console.error(e);
  try {
    await sequelize.close();
  } catch (_) {}
  process.exit(1);
});
