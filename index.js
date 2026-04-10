require("dotenv").config();
const http = require("http");
const app = require("./src/app");
const { initDb, sequelize } = require("./src/config/sequelize");
const cors = require("cors");
const { initSockets } = require("./src/socket");
const {
  initChromaDB,
  getChatCollection,
  getSessionCollection,
} = require("./src/config/chromadb");

/* 🔓 CORS CONFIG */

app.use(
  cors({
    origin: "*",
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS"],
    allowedHeaders: ["Content-Type", "Authorization"],
  }),
);

const PORT = process.env.PORT;
const server = http.createServer(app);
let io;

// Start HTTP server immediately — don't block on DB init
io = initSockets(server);

server.on("error", (err) => {
  console.error("[startup] Server listen error:", err.message);
});

server.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});

// DB init + ChromaDB run in background
initDb()
  .then(() => {
    console.log("[startup] Database fully initialized");

    // ChromaDB is fire-and-forget
    initChromaDB()
      .then(() => getChatCollection())
      .then(() => getSessionCollection())
      .then(() => console.log("ChromaDB initialized successfully"))
      .catch((chromaErr) => {
        console.warn("ChromaDB initialization failed (non-fatal):", chromaErr.message);
      });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    console.warn("[startup] Continuing without full DB initialization");
  });

// Graceful shutdown handlers
const gracefulShutdown = async (signal) => {
  console.log(`\n${signal} received. Closing server gracefully...`);

  server.close(async () => {
    console.log("HTTP server closed.");
    try {
      await sequelize.close();
      console.log("Database connections closed.");
    } catch (err) {
      console.error("Error closing database connections:", err);
    }
    process.exit(0);
  });

  setTimeout(() => {
    console.error("Forced shutdown after timeout");
    process.exit(1);
  }, 10000);
};

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
