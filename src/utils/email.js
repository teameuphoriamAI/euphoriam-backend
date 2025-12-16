require("dotenv").config();
const nodemailer = require("nodemailer");

const sender_email = process.env.SENDER_EMAIL;
const sender_password = process.env.SENDER_PASSWORD;
const sender_name = process.env.SENDER_NAME;
const logoImage = process.env.LOGO_URL;

const transporter = nodemailer.createTransport({
  host: "smtp.gmail.com",
  port: 465, // usually 587 for STARTTLS
  secure: true, // true for port 465
  auth: {
    user: sender_email,
    pass: sender_password,
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
