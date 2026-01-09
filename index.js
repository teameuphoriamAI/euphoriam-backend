require("dotenv").config();
const http = require("http");
const app = require("./src/app");
const { initDb } = require("./src/config/sequelize");
const cors = require("cors");
const { initSockets } = require("./src/socket");

/* 🔓 CORS CONFIG */
app.use(
  cors({
    origin: `${process.env.FRONTEND_URL}`,
    methods: ["GET", "POST", "PUT", "DELETE", "OPTIONS", "PATCH"],
    allowedHeaders: ["Content-Type", "Authorization"],
    credentials: true,
  })
);

const PORT = process.env.PORT;
const server = http.createServer(app);
let io;

initDb()
  .then(() => {
    io = initSockets(server);

    // Increase server timeout for long-running operations (report generation, PDF, etc.)
    // 5 minutes = 300000ms
    // This allows API requests to take up to 5 minutes before timing out
    server.timeout = 300000; // 5 minutes - maximum time for request to complete
    server.keepAliveTimeout = 300000; // 5 minutes - keep connections alive for full duration
    server.headersTimeout = 301000; // 5 minutes + 1 second - allow time for headers

    console.log("Server timeouts configured: 5 minutes (300000ms)");

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
