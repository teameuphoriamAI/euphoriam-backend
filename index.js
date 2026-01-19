require("dotenv").config();
const http = require("http");
const app = require("./src/app");
const { initDb, sequelize } = require("./src/config/sequelize");
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

    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });

    // Graceful shutdown handlers
    const gracefulShutdown = async (signal) => {
      console.log(`\n${signal} received. Closing server gracefully...`);
      
      server.close(async () => {
        console.log("HTTP server closed.");
        
        // Close database connections
        try {
          await sequelize.close();
          console.log("Database connections closed.");
        } catch (err) {
          console.error("Error closing database connections:", err);
        }
        
        process.exit(0);
      });

      // Force close after 10 seconds
      setTimeout(() => {
        console.error("Forced shutdown after timeout");
        process.exit(1);
      }, 10000);
    };

    process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
    process.on("SIGINT", () => gracefulShutdown("SIGINT"));
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
