const pdf = require("pdf-parse");

/**
 * Extracts text from a PDF file buffer
 * @param {Buffer} pdfBuffer - PDF file buffer
 * @returns {Promise<string>} Extracted text from PDF
 */
const extractTextFromPdf = async (pdfBuffer) => {
  if (!pdfBuffer || !Buffer.isBuffer(pdfBuffer)) {
    throw new Error("PDF buffer is required");
  }

  try {
    const data = await pdf(pdfBuffer);
    return data.text || "";
  } catch (error) {
    throw new Error(`Failed to extract text from PDF: ${error.message}`);
  }
};

module.exports = { extractTextFromPdf };

