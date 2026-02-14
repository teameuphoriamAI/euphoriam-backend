/**
 * Script to sync existing chats and sessions to the vector database
 * Run this once to backfill existing data into ChromaDB
 * 
 * Usage: node src/scripts/syncVectorDB.js
 */

require("dotenv").config();
const { initDb } = require("../config/sequelize");
const { initChromaDB, getChatCollection, getSessionCollection } = require("../config/chromadb");
const { Chat } = require("../models/chatModel");
const { UserSession } = require("../models/userSessionModel");
const { storeChatInVectorDB, storeSessionInVectorDB } = require("../services/vectorStoreService");

const BATCH_SIZE = 10;

/**
 * Sync all chats to vector database
 */
const syncChats = async () => {
  console.log("\n📝 Syncing chats to vector database...");
  
  try {
    const totalChats = await Chat.count();
    console.log(`Found ${totalChats} chats to sync`);

    let synced = 0;
    let failed = 0;
    let offset = 0;

    while (offset < totalChats) {
      const chats = await Chat.findAll({
        limit: BATCH_SIZE,
        offset: offset,
        order: [["createdAt", "ASC"]],
      });

      for (const chat of chats) {
        try {
          const transcript = chat.data?.transcript || [];
          if (transcript.length === 0) {
            console.log(`  ⏭️  Skipping chat ${chat.id} (empty transcript)`);
            continue;
          }

          await storeChatInVectorDB({
            chatId: chat.id,
            userId: chat.userId,
            transcript: transcript,
            chatType: chat.chatType,
            metadata: { createdAt: chat.createdAt },
          });

          synced++;
          process.stdout.write(`\r  ✅ Synced ${synced}/${totalChats} chats`);
        } catch (err) {
          failed++;
          console.error(`\n  ❌ Failed to sync chat ${chat.id}:`, err.message);
        }
      }

      offset += BATCH_SIZE;
    }

    console.log(`\n✅ Chats sync complete: ${synced} synced, ${failed} failed`);
  } catch (error) {
    console.error("Error syncing chats:", error);
  }
};

/**
 * Sync all user sessions to vector database
 */
const syncSessions = async () => {
  console.log("\n📚 Syncing user sessions to vector database...");
  
  try {
    const totalSessions = await UserSession.count();
    console.log(`Found ${totalSessions} sessions to sync`);

    let synced = 0;
    let failed = 0;
    let offset = 0;

    while (offset < totalSessions) {
      const sessions = await UserSession.findAll({
        limit: BATCH_SIZE,
        offset: offset,
        order: [["createdAt", "ASC"]],
      });

      for (const session of sessions) {
        try {
          const transcript = session.transcript || [];
          if (transcript.length === 0) {
            console.log(`  ⏭️  Skipping session ${session.id} (empty transcript)`);
            continue;
          }

          await storeSessionInVectorDB({
            sessionId: session.id,
            userId: session.userId,
            email: session.email,
            transcript: transcript,
            summary: session.summery,
            metadata: {
              sessionDate: session.sessionDate,
              createdAt: session.createdAt,
            },
          });

          synced++;
          process.stdout.write(`\r  ✅ Synced ${synced}/${totalSessions} sessions`);
        } catch (err) {
          failed++;
          console.error(`\n  ❌ Failed to sync session ${session.id}:`, err.message);
        }
      }

      offset += BATCH_SIZE;
    }

    console.log(`\n✅ Sessions sync complete: ${synced} synced, ${failed} failed`);
  } catch (error) {
    console.error("Error syncing sessions:", error);
  }
};

/**
 * Main sync function
 */
const main = async () => {
  console.log("🚀 Starting vector database sync...\n");

  try {
    // Initialize database
    console.log("Connecting to PostgreSQL...");
    await initDb();
    console.log("✅ PostgreSQL connected");

    // Initialize ChromaDB
    console.log("\nInitializing ChromaDB...");
    await initChromaDB();
    await getChatCollection();
    await getSessionCollection();
    console.log("✅ ChromaDB initialized");

    // Sync chats
    await syncChats();

    // Sync sessions
    await syncSessions();

    console.log("\n🎉 Vector database sync complete!");
    process.exit(0);
  } catch (error) {
    console.error("\n❌ Sync failed:", error);
    process.exit(1);
  }
};

// Run the script
main();
