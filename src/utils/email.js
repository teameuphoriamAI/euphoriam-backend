require("dotenv").config();
const nodemailer = require("nodemailer");

const brevoLogin = process.env.BREVO_LOGIN; // Your Brevo account login email
const brevoSmtpKey = process.env.BREVO_SMTP_KEY; // SMTP key from Brevo
const sender_email = process.env.SENDER_EMAIL; // Verified sender email
const sender_name = process.env.SENDER_NAME;
const logoImage = process.env.LOGO_URL;

const transporter = nodemailer.createTransport({
  host: "smtp-relay.brevo.com",
  port: 587,
  secure: false,
  auth: {
    user: brevoLogin,
    pass: brevoSmtpKey,
  },
});
/**
 * Send Email
 * @param {string} email - recipient
 * @param {string} subject - subject line
 * @param {string} content - HTML content
 * @param {string} pdfPath - local path to diagnostic PDF
 */
const sendEmail = async (email, subject, content, pdfPath) => {
  try {
    const mailOptions = {
      from: `${sender_name} <${sender_email}>`,
      to: email,
      subject,
      html: content,
      attachments: [
        // Logo (inline)
        {
          filename: "EuphoriumAi-logo.png",
          path: logoImage,
          cid: "logo",
        },

        // Diagnostic Report PDF
        {
          filename: "Diagnostic-Report.pdf",
          path: pdfPath, // e.g. "./reports/user-123.pdf"
          contentType: "application/pdf",
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    console.log("✅ Email sent with PDF!");
  } catch (error) {
    console.error("❌ Failed to send email:", error);
  }
};
module.exports = { sendEmail };
