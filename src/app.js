const express = require("express");
const routes = require("./routes");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// Core middleware
// Increased body size limits for large PDF uploads
app.use(express.json({ limit: "50mb" }));
app.use(express.urlencoded({ extended: true, limit: "50mb" }));

// Route registration
app.use("/api", routes);

// Fallbacks
app.use(notFound);
app.use(errorHandler);

module.exports = app;


