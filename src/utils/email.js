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
 * @param {string} content - HTML content (use `cid:logo` where you want the logo)
 */
const sendEmail = async (email, subject, content) => {
  try {
    const mailOptions = {
      from: `${sender_name} <${sender_email}>`,
      to: email,
      subject,
      html: content,
      attachments: [
        {
          filename: "EuphoriumAi-logo.png",
          path: logoImage,
          cid: "logo",
        },
      ],
    };

    await transporter.sendMail(mailOptions);
    console.log(" Email sent!");
  } catch (error) {
    console.error(" Failed to send email:", error);
  }
};

module.exports = { sendEmail };
