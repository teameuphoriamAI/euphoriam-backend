const logger = require("../utils/logger");

const errorHandler = (err, req, res, _next) => {
  let status = err.status || 500;
  let message = err.message || "Internal server error";

  // Handle serverless platform payload size errors
  if (
    err.message?.includes("FUNCTION_PAYLOAD_TOO_LARGE") ||
    err.message?.includes("Request Entity Too Large") ||
    err.message?.includes("PayloadTooLargeError") ||
    status === 413
  ) {
    status = 413;
    message =
      "File too large. The request payload exceeds the server limit. " +
      "For large video files, consider using direct upload to storage or splitting the file into smaller chunks. " +
      "Maximum recommended size: 500MB for traditional servers, 4.5MB for serverless platforms.";
  }

  logger.error({
    message,
    status,
    stack: err.stack,
    path: req.originalUrl,
    method: req.method,
  });

  res.status(status).json({
    success: false,
    message,
  });
};

module.exports = errorHandler;



