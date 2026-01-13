const express = require("express");
const routes = require("./routes");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// Core middleware
// Increased body size limits for large file uploads (PDFs, videos, etc.)
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));

// Route registration
app.use("/api", routes);

// Fallbacks
app.use(notFound);
app.use(errorHandler);

module.exports = app;


