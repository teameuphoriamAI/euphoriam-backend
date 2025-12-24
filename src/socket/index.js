const { Server } = require("socket.io");
const { wireChatbotFreeform } = require("./chatbotFreeformSocket");

const initSockets = (server) => {
  const io = new Server(server, {
    cors: {
      origin: "*",
      methods: ["GET", "POST"],
    },
  });

  wireChatbotFreeform(io);

  return io;
};

module.exports = { initSockets };

