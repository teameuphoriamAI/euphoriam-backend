/**
 * Delete ongoing (incomplete) chat session rows from PostgreSQL and remove matching
 * chunks from ChromaDB when possible.
 *
 * "Ongoing" means chat.isChatEnded === false (see saveChatIncrementally in chatController).
 *
 * Usage:
 *   npm run delete:ongoing-chat -- --email=user@example.com
 *   npm run delete:ongoing-chat -- --user-id=42
 *   npm run delete:ongoing-chat -- --email=user@example.com --all-ongoing
 *   npm run delete:ongoing-chat -- --email=user@example.com --chat-type=Discovery
 *   npm run delete:ongoing-chat -- --chat-id=123
 *   npm run delete:ongoing-chat -- --email=user@example.com --funnel-access-id=<funnel_access_id>
 *
 * Options:
 *   --email=           User email (resolve to userId)
 *   --user-id=         User id
 *   --chat-id=         Delete this chat only (must be ongoing unless you add support later)
 *   --all-ongoing      With email/user-id: delete every incomplete chat for that user
 *                      (default: only the latest incomplete chat)
 *   --chat-type=       Filter by type, e.g. Diagnostic, Discovery, "Diagnostic Chat"
 *   --funnel-access-id= Same id as in chat.data (funnel token access id). Matches GET /api/funnel/chats
 *                      filtering so you remove the open IRL thread, not some other incomplete chat.
 */

require("dotenv").config();
const { Op } = require("sequelize");
const { sequelize } = require("../config/sequelize");
const { Chat } = require("../models/chatModel");
const { User } = require("../models/userModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { deleteChatFromVectorDB } = require("../services/vectorStoreService");

function parseArgs() {
  const out = {};
  for (const a of process.argv.slice(2)) {
    if (!a.startsWith("--")) continue;
    const eq = a.indexOf("=");
    if (eq === -1) {
      out[a.slice(2)] = true;
    } else {
      out[a.slice(2, eq)] = a.slice(eq + 1);
    }
  }
  return out;
}

async function clearDiagnosticChatLink(chatId) {
  await Diagnostic.update({ chatId: null }, { where: { chatId } });
}

async function removeOneChat(chat) {
  const id = chat.id;
  await clearDiagnosticChatLink(id);
  await chat.destroy();
  try {
    await deleteChatFromVectorDB(id);
  } catch (e) {
    console.warn(`[deleteOngoingChatSession] Vector DB cleanup failed for chat ${id}:`, e.message || e);
  }
  console.log(`Deleted ongoing chat id=${id} (userId=${chat.userId}, type=${chat.chatType})`);
}

async function main() {
  const args = parseArgs();
  const email = args.email;
  const userIdArg = args["user-id"];
  const chatIdArg = args["chat-id"];
  const allOngoing = Boolean(args["all-ongoing"]);
  const chatType = args["chat-type"];
  const funnelAccessId = args["funnel-access-id"];

  if (!chatIdArg && !email && !userIdArg) {
    console.error("Provide --email=, --user-id=, or --chat-id=.");
    process.exit(1);
  }

  await sequelize.authenticate();

  let chats = [];

  if (chatIdArg) {
    const id = Number(chatIdArg);
    if (!Number.isFinite(id)) {
      console.error("Invalid --chat-id (expected a number).");
      process.exit(1);
    }
    const chat = await Chat.findByPk(id);
    if (!chat) {
      console.error(`No chat found with id=${id}.`);
      process.exit(1);
    }
    if (chat.isChatEnded) {
      console.error(`Chat ${id} is already ended (isChatEnded=true). This script only removes ongoing sessions.`);
      process.exit(1);
    }
    if (email) {
      const user = await User.findOne({ where: { email: String(email).trim() } });
      if (!user || Number(user.id) !== Number(chat.userId)) {
        console.error("--email does not match the owner of this chat.");
        process.exit(1);
      }
    }
    if (userIdArg && Number(userIdArg) !== Number(chat.userId)) {
      console.error("--user-id does not match the owner of this chat.");
      process.exit(1);
    }
    chats = [chat];
  } else {
    let userId = userIdArg ? Number(userIdArg) : null;
    if (email) {
      const user = await User.findOne({ where: { email: String(email).trim() } });
      if (!user) {
        console.error(`No user found for email=${email}`);
        process.exit(1);
      }
      userId = user.id;
    }
    if (!userId || !Number.isFinite(Number(userId))) {
      console.error("Could not resolve user id from --email or --user-id.");
      process.exit(1);
    }

    const where = {
      userId,
      isChatEnded: false,
    };
    if (chatType) {
      where.chatType = chatType;
    }
    if (funnelAccessId) {
      const accessIdStr = String(funnelAccessId);
      const funnelChatLiteral = sequelize.literal(
        `("Chat"."data"->>'funnel_access_id') = ${sequelize.escape(accessIdStr)} AND (("Chat"."data"->>'funnelMode') = 'true' OR ("Chat"."data"->>'report_type') = ${sequelize.escape("invisible_red_line")})`,
      );
      where[Op.and] = where[Op.and]
        ? [].concat(where[Op.and], funnelChatLiteral)
        : funnelChatLiteral;
    }

    const order = funnelAccessId
      ? [["updatedAt", "DESC"]]
      : [["createdAt", "DESC"]];

    if (allOngoing) {
      chats = await Chat.findAll({
        where,
        order,
      });
    } else {
      const one = await Chat.findOne({
        where,
        order,
      });
      chats = one ? [one] : [];
    }
  }

  if (chats.length === 0) {
    console.log("No ongoing chat sessions matched. Nothing to delete.");
    await sequelize.close();
    process.exit(0);
  }

  for (const chat of chats) {
    await removeOneChat(chat);
  }

  console.log(`Done. Removed ${chats.length} session(s).`);
  await sequelize.close();
  process.exit(0);
}

main().catch(async (err) => {
  console.error(err);
  try {
    await sequelize.close();
  } catch (_) {
    /* ignore */
  }
  process.exit(1);
});
