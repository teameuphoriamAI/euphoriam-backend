const express = require("express");
const routes = require("./routes");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");
const cors = require("cors");

const app = express();

// Core middleware
// Increased body size limits for large file uploads (PDFs, videos, etc.)
app.use(express.json({ limit: "500mb" }));
app.use(express.urlencoded({ extended: true, limit: "500mb" }));

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

// Route registration
app.use("/api", routes);

// Fallbacks
app.use(notFound);
app.use(errorHandler);

module.exports = app;
