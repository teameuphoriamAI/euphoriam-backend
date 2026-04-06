const express = require("express");
const userRoutes = require("./userRoutes");
const authRoutes = require("./authRoutes");
const diagnosticRoutes = require("./diagnosticRoutes");
const kajabiRoutes = require("./kajabi");
const voiceRoutes = require("./voiceRoutes");
const ragRoutes = require("./ragRoutes");
const discoveryRoutes = require("./discoveryRoutes");
// const discoveryChatRoutes = require("./discoveryChatRoutes");
const adminRoutes = require("./adminRoutes");
const chatRoutes = require("./chatRoutes");
const barcodeRoutes = require("./barcodeRoutes");
const funnelRoutes = require("./funnelRoutes");

const router = express.Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

router.use("/auth", authRoutes);
router.use("/users", userRoutes);
router.use("/diagnostics", diagnosticRoutes);
router.use("/barcode", barcodeRoutes);
router.use("/kajabi", kajabiRoutes);
router.use("/voice-notes", voiceRoutes);
router.use("/rag", ragRoutes);
router.use("/discoveries", discoveryRoutes);
// router.use("/discoveriesChat", discoveryChatRoutes);
router.use("/admin", adminRoutes);
router.use("/chat", chatRoutes);
router.use("/funnel", funnelRoutes);

module.exports = router;
