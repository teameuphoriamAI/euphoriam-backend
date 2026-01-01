const express = require("express");
const userRoutes = require("./userRoutes");
const authRoutes = require("./authRoutes");
const diagnosticRoutes = require("./diagnosticRoutes");
const kajabiRoutes = require("./kajabi");
const voiceRoutes = require("./voiceRoutes");
const ragRoutes = require("./ragRoutes");
const discoveryRoutes = require("./discoveryRoutes");
const adminRoutes = require("./adminRoutes");

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/diagnostics", diagnosticRoutes);
router.use("/diagnostic", diagnosticRoutes); // Alias for backward compatibility
router.use("/kajabi", kajabiRoutes);
router.use("/voice-notes", voiceRoutes);
router.use("/rag", ragRoutes);
router.use("/discoveries", discoveryRoutes);
router.use("/admin", adminRoutes);

module.exports = router;
