const express = require("express");
const routes = require("./routes");
const notFound = require("./middleware/notFound");
const errorHandler = require("./middleware/errorHandler");

const app = express();

// Core middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Route registration
app.use("/api", routes);

// Fallbacks
app.use(notFound);
app.use(errorHandler);

module.exports = app;


