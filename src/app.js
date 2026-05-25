const express = require("express");
const routes = require("./routes");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");
const cors = require("cors");
const { setupSwagger } = require("./swagger");

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

/** Site root — Render and uptime tools often probe `HEAD GET /`; only `/api` was mounted previously (404). */
app.head("/", (_req, res) => res.sendStatus(200));
app.get("/", (_req, res) =>
  res.status(200).type("text/plain").send("Euphoriam API"),
);

// API docs (Stage 1 + auth login for testing)
setupSwagger(app);

// Route registration
app.use("/api", routes);

// Fallbacks
app.use(notFound);
app.use(errorHandler);

module.exports = app;
