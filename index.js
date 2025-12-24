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
    server.listen(PORT, () => {
      console.log(`Server running on port ${PORT}`);
    });
  })
  .catch((err) => {
    console.error("Failed to initialize database:", err);
    process.exit(1);
  });
