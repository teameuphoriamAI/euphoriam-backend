require("dotenv").config();

const logoUrl = process.env.LOGO_URL;
const supportEmail = process.env.SUPPORT_EMAIL;

/**
 * Funnel access link email — Option B fallback delivery.
 *
 * Sent by the backend when Kajabi cannot embed the link directly in their
 * confirmation email (e.g. automation limitation). Nathan voice — short and direct.
 *
 * @param {string} firstName   - User's first name (derived from email prefix if unknown)
 * @param {string} diagnosticLink - The full signed funnel access URL
 * @param {number} [daysValid=10] - How many days the link is valid for
 * @returns {string} HTML email string
 */
const funnelAccessEmail = (firstName = "there", diagnosticLink = "", daysValid = 10) => {
  const name = firstName || "there";
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Your Free Euphoriam AI Diagnosis</title>
  <style>
    @media only screen and (max-width: 600px) {
      .email-container { width: 100% !important; padding: 20px !important; }
      .cta-button { width: 90% !important; text-align: center !important; }
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

          <!-- Label -->
          <tr>
            <td style="padding-bottom:6px;">
              <p style="margin:0;font-size:11px;letter-spacing:2px;text-transform:uppercase;color:#9b59b6;font-weight:600;text-align:center;">
                Your Free Diagnostic Access
              </p>
            </td>
          </tr>

          <!-- Heading -->
          <tr>
            <td style="padding-bottom:24px;border-bottom:2px solid #f0e9ff;text-align:center;">
              <h1 style="margin:0;font-size:24px;color:#1a1a1a;line-height:1.3;font-weight:700;">
                Your Invisible Red Line Diagnosis is ready.
              </h1>
            </td>
          </tr>

          <!-- Greeting -->
          <tr>
            <td style="padding-top:28px;padding-bottom:16px;">
              <p style="margin:0;font-size:16px;color:#333;line-height:1.8;">
                Hi ${name},
              </p>
            </td>
          </tr>

          <!-- Body copy — Nathan voice -->
          <tr>
            <td style="padding-bottom:16px;">
              <p style="margin:0;font-size:16px;color:#333;line-height:1.8;">
                Your free Euphoriam AI Diagnosis link is ready.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:16px;">
              <p style="margin:0;font-size:16px;color:#333;line-height:1.8;">
                Answer <strong>25 short questions</strong> and the system will generate your
                personal <strong>Invisible Red Line Report</strong> — a map of the hidden
                structure most likely capping your results in money, relationships, and momentum.
              </p>
            </td>
          </tr>
          <tr>
            <td style="padding-bottom:28px;">
              <p style="margin:0;font-size:15px;color:#666;line-height:1.7;">
                This link is valid for <strong>${daysValid} days</strong> and gives you
                up to <strong>3 diagnostic sessions</strong>.
              </p>
            </td>
          </tr>

          <!-- CTA button -->
          <tr>
            <td align="center" style="padding-bottom:28px;">
              <a href="${diagnosticLink}" class="cta-button"
                style="display:inline-block;background-color:#7c3aed;color:#ffffff;font-size:16px;font-weight:600;
                       text-decoration:none;padding:14px 36px;border-radius:10px;letter-spacing:0.3px;">
                Get Your Free Diagnosis →
              </a>
            </td>
          </tr>

          <!-- Fallback link -->
          <tr>
            <td style="padding-bottom:24px;border-top:1px solid #f0e9ff;padding-top:20px;">
              <p style="margin:0;font-size:13px;color:#999;line-height:1.6;text-align:center;">
                If the button doesn't work, copy and paste this link into your browser:<br/>
                <a href="${diagnosticLink}" style="color:#7c3aed;word-break:break-all;font-size:12px;">
                  ${diagnosticLink}
                </a>
              </p>
            </td>
          </tr>

          <!-- Sign-off -->
          <tr>
            <td style="padding-bottom:8px;">
              <p style="margin:0;font-size:15px;color:#333;line-height:1.7;">
                — Nathan &amp; the Euphoriam team
              </p>
            </td>
          </tr>

          <!-- Support -->
          ${supportEmail ? `
          <tr>
            <td>
              <p style="margin:0;font-size:13px;color:#999;line-height:1.6;">
                Questions? Reply to this email or contact
                <a href="mailto:${supportEmail}" style="color:#7c3aed;text-decoration:none;">${supportEmail}</a>
              </p>
            </td>
          </tr>` : ""}

          <!-- Footer -->
          <tr>
            <td style="padding-top:24px;">
              <p style="margin:0;font-size:12px;color:#bbb;text-align:center;">
                Euphoriam AI · This link was generated for ${name}'s email address only.
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

module.exports = { funnelAccessEmail };
