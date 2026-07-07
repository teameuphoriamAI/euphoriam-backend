require("dotenv").config();

const supportEmail = process.env.SUPPORT_EMAIL;
const logoUrl = process.env.LOGO_URL;
const unauthorizedAccessEmailTemplate = (userName) => {
  return `
  <!DOCTYPE html>
  <html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0"/>
    <title>Account Access Alert</title>
    <style>
      @media only screen and (max-width: 600px) {
        .email-container {
          width: 100% !important;
          padding: 20px !important;
        }
        .logo-container img {
          width: 80px !important;
        }
      }
      img {
        background-color: transparent !important;
        background: transparent !important;
      }
    </style>
  </head>

  <body style="margin: 0; padding: 0; background-color: #F7F4ED; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif;">
    <table width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color: #F7F4ED; padding: 40px 0;">
      <tr>
        <td align="center">

          <table width="600" cellpadding="0" cellspacing="0" border="0" class="email-container"
            style="background-color: #ffffff; border-radius: 12px; padding: 40px; box-shadow: 0 8px 30px rgba(0,0,0,0.07); max-width: 100%;">

            <!-- Logo -->
            <tr>
              <td align="center" class="logo-container" style="padding-bottom: 30px;">
                <img
                  src="${logoUrl}"
                  alt="Euphoriam-AI Logo"
                  width="110"
                  style="display: block; max-width: 100%; height: auto; border: 0;"
                />
              </td>
            </tr>

            <!-- Greeting -->
            <tr>
              <td style="font-size: 20px; color: #4A595A; text-align: center; padding-bottom: 12px;">
                Hello ${userName},
              </td>
            </tr>

            <!-- Message -->
            <tr>
              <td style="font-size: 16px; color: #333333; text-align: center; line-height: 1.6; padding-bottom: 20px;">
                We detected an attempt to access your account.
                If this was you, you can safely ignore this email.
                Otherwise, please contact our support team immediately to secure your account.
              </td>
            </tr>

            <!-- Support -->
            <tr>
              <td style="font-size: 14px; color: #555555; text-align: center; line-height: 1.6; padding-top: 16px;">
                Need help? Contact us at
                <a href="mailto:${supportEmail}" style="color: #4A595A; text-decoration: none;">
                  ${supportEmail}
                </a>
              </td>
            </tr>

            <!-- Footer -->
            <tr>
              <td style="font-size: 14px; color: #888888; text-align: center; padding-top: 40px;">
                — The Euphoriam-AI Team
              </td>
            </tr>

          </table>

        </td>
      </tr>
    </table>
  </body>
  </html>
  `;
};

module.exports = { unauthorizedAccessEmailTemplate };
