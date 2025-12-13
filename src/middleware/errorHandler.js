const logger = require("../utils/logger");

const errorHandler = (err, req, res, _next) => {
  const status = err.status || 500;
  const message = err.message || "Internal server error";

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



