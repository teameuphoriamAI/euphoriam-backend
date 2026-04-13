require("dotenv").config();

const { IRL_REPORT_SUBTITLE_V22 } = require("../../constants/irlBranding");

const logoUrl = process.env.LOGO_URL;
const ucSalesUrl = process.env.UC_SALES_URL || "";
const ctaText = process.env.UC_CTA_TEXT || "Start Unlimited Creator";

/**
 * Email template for the Invisible Red Line Report delivery.
 * Short and direct — Nathan voice. The PDF is the real payload;
 * the email just frames it with the right message.
 *
 * @param {string} firstName - User's first name (from email prefix or profile)
 * @returns {string} HTML email string
 */
const irlReportEmail = (firstName = "there") => {
  const name = firstName || "there";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Invisible Red Line Report</title>
  <style>
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; padding: 20px !important; }
      .cta-button { width: 100% !important; text-align: center !important; }
    }
  </style>
</head>
<body style="margin:0;padding:0;background-color:#F7F4ED;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Arial,sans-serif;">

  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:#F7F4ED;padding:40px 0;">
    <tr>
      <td align="center">
        <table width="600" cellpadding="0" cellspacing="0" border="0" class="email-container"
          style="background-color:#ffffff;border-radius:12px;padding:40px;box-shadow:0 8px 30px rgba(0,0,0,0.07);max-width:100%;">

          ${logoUrl ? `
          <!-- Logo -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <img src="${logoUrl}" alt="Euphoriam AI" width="100"
                style="display:block;max-width:100%;height:auto;border:0;" />
            </td>
          </tr>` : ""}

          <!-- Report title -->
          <tr>
            <td style="padding-bottom:6px;">
              <p style="margin:0;font-size:13px;letter-spacing:2px;text-transform:uppercase;color:#9b59b6;font-weight:600;">
                Your Personalised Report
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:24px;border-bottom:2px solid #f0e9ff;">
              <h1 style="margin:0;font-size:26px;color:#1a1a1a;line-height:1.3;font-weight:700;">
                Your Invisible Red Line Report
              </h1>
              <p style="margin:10px 0 0;font-size:14px;color:#666;line-height:1.5;">
                ${IRL_REPORT_SUBTITLE_V22}
              </p>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding-top:28px;padding-bottom:20px;">
              <p style="margin:0;font-size:17px;color:#222;line-height:1.7;">
                Hi ${name},
              </p>
            </td>
          </tr>

          <!-- Main message — Nathan voice -->
          <tr>
            <td style="padding-bottom:20px;">
              <p style="margin:0;font-size:16px;color:#333;line-height:1.8;">
                Your Invisible Red Line Report is attached.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:20px;">
              <p style="margin:0;font-size:16px;color:#333;line-height:1.8;">
                This report names the hidden pattern that may be pulling you off course — in plain English — and what it is probably costing you.
                Read it once slowly. Then read <strong>Section 4</strong> and <strong>Section 5</strong> again.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:28px;">
              <p style="margin:0;font-size:16px;color:#333;line-height:1.8;">
                If it landed — if you read it and thought <em>"this is exactly it"</em> — then
                Unlimited Creator is the logical next step.
              </p>
            </td>
          </tr>

          <!-- Attachment notice -->
          <tr>
            <td style="background-color:#f9f4ff;border-radius:8px;border-left:4px solid #9b59b6;padding:18px 20px;margin-bottom:28px;">
              <p style="margin:0;font-size:15px;color:#333;line-height:1.6;">
                📎 <strong>Your Invisible Red Line Report is attached as a PDF.</strong><br />
                Download and save it — it's yours to keep.
              </p>
            </td>
          </tr>

          ${ucSalesUrl ? `
          <!-- CTA button -->
          <tr>
            <td align="center" style="padding-top:28px;padding-bottom:28px;">
              <a href="${ucSalesUrl}" class="cta-button"
                style="display:inline-block;background-color:#7c3aed;color:#ffffff;font-size:16px;font-weight:600;
                       text-decoration:none;padding:14px 36px;border-radius:8px;letter-spacing:0.5px;">
                ${ctaText}
              </a>
            </td>
          </tr>` : ""}

          <!-- Sign-off -->
          <tr>
            <td style="padding-top:8px;border-top:1px solid #f0e9ff;">
              <p style="margin:16px 0 4px;font-size:15px;color:#333;line-height:1.7;">
                — Nathan &amp; the Euphoriam team
              </p>
            </td>
          </tr>

          <!-- Footer -->
          <tr>
            <td style="padding-top:20px;">
              <p style="margin:0;font-size:13px;color:#999;line-height:1.6;text-align:center;">
                Euphoriam AI · This report is generated using AI-assisted analysis and is for informational purposes.
              </p>
            </td>
          </tr>

        </table>
      </td>
    </tr>
  </table>
</body>
</html>`;
};

module.exports = { irlReportEmail };
