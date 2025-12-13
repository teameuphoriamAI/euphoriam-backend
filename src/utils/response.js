exports.successResponse = (
  res,
  message,
  result,
  statusCode = 200,
  headers = {}
) => {
  if (typeof statusCode !== "number") {
    console.error("Invalid status code:", statusCode);
    statusCode = 200;
  }

  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  res.status(statusCode).json({
    status: true,
    message,
    result,
  });
};
exports.errorResponse = (
  res,
  error,
  statusCode = 500,
  result = null,
  headers = {}
) => {
  if (typeof statusCode !== "number") {
    console.error("Invalid status code:", statusCode);
    statusCode = 500;
  }

  Object.entries(headers).forEach(([key, value]) => {
    res.setHeader(key, value);
  });

  let errorMessage = error;
  if (typeof error === "object" && error !== null) {
    errorMessage = error.message || JSON.stringify(error);
  }

  res.status(statusCode).json({
    status: false,
    error: errorMessage,
    result,
  });
};

// Convenience helper for simple success payloads
exports.ok = (
  res,
  result = null,
  message = "OK",
  statusCode = 200,
  headers = {}
) => exports.successResponse(res, message, result, statusCode, headers);

