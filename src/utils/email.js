require("dotenv").config();
const axios = require("axios");
const fs = require("fs");

const BREVO_API_KEY = process.env.BREVO_API_KEY;
const sender_email = process.env.SENDER_EMAIL;
const sender_name = process.env.SENDER_NAME;
const logoImage = process.env.LOGO_URL;

/**
 * Send Email using Brevo API
 * @param {string} email - recipient
 * @param {string} subject - subject line
 * @param {string} content - HTML content
 * @param {string} pdfPath - local path to diagnostic PDF
 */
const sendEmail = async (email, subject, content, pdfPath) => {
  try {
    // Read PDF and convert to base64
    const pdfBase64 = fs.readFileSync(pdfPath, {
      encoding: "base64",
    });

    const payload = {
      sender: {
        email: sender_email,
        name: sender_name,
      },
      to: [
        {
          email,
        },
      ],
      subject,
      htmlContent: content,
      attachment: [
        {
          content: pdfBase64,
          name: "Diagnostic-Report.pdf",
        },
      ],
    };

    await axios.post("https://api.brevo.com/v3/smtp/email", payload, {
      headers: {
        "api-key": BREVO_API_KEY,
        "Content-Type": "application/json",
      },
      timeout: 15000,
    });

    console.log("✅ Email sent via Brevo API!");
  } catch (error) {
    console.error(
      "❌ Failed to send email:",
      error.response?.data || error.message
    );
  }
};

module.exports = { sendEmail };
