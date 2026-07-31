const { ChromaClient, CloudClient } = require("chromadb");

// ChromaDB client instance
let chromaClient = null;
let chatCollection = null;
let sessionCollection = null;
let chromaDisabled = false;

/** chromadb JS v3+ talks to a server URL or Cloud — not a filesystem directory. */
const isChromaConfigured = () => {
  if (chromaDisabled) return false;
  const hasCloud =
    process.env.CHROMA_DB_API_KEY &&
    process.env.CHROMA_DB_TENANT &&
    process.env.CHROMA_DB_DATABASE;
  const hasUrl = Boolean(process.env.CHROMA_DB_URL?.trim());
  return Boolean(hasCloud || hasUrl);
};

// Collection names
const COLLECTIONS = {
  CHATS: "chat_history",
  SESSIONS: "user_sessions",
};

/**
 * Initialize ChromaDB client
 * Supports multiple modes (checked in priority order):
 * 1. ChromaDB Cloud - uses CHROMA_DB_API_KEY, CHROMA_DB_TENANT, CHROMA_DB_DATABASE env vars
 * 2. Remote ChromaDB server - uses CHROMA_DB_URL env var
 * 3. Local persistent storage - uses CHROMA_DB_PATH env var
 * 4. Ephemeral (in-memory) - default fallback, no persistence
 */
const initChromaDB = async () => {
  try {
    if (chromaClient) {
      console.log("ChromaDB already initialized");
      return chromaClient;
    }

    // Check for ChromaDB Cloud credentials (highest priority)
    const chromaDbApiKey = process.env.CHROMA_DB_API_KEY;
    const chromaDbTenant = process.env.CHROMA_DB_TENANT;
    const chromaDbDatabase = process.env.CHROMA_DB_DATABASE;

    // Check for other configuration options
    const chromaDbUrl = process.env.CHROMA_DB_URL; // e.g., "http://localhost:8000"
    const chromaDbPath = process.env.CHROMA_DB_PATH; // e.g., "./chroma_data" or "/var/lib/chromadb"

    // Initialize ChromaDB client based on configuration (priority order)
    if (chromaDbApiKey && chromaDbTenant && chromaDbDatabase) {
      // ChromaDB Cloud (preferred for production)
      console.log("Initializing ChromaDB Cloud client");
      console.log(`  Tenant: ${chromaDbTenant}`);
      console.log(`  Database: ${chromaDbDatabase}`);
      chromaClient = new CloudClient({
        apiKey: chromaDbApiKey,
        tenant: chromaDbTenant,
        database: chromaDbDatabase,
      });
    } else if (chromaDbUrl) {
      // Remote ChromaDB server
      console.log(`Initializing ChromaDB client with remote server: ${chromaDbUrl}`);
      chromaClient = new ChromaClient({ path: chromaDbUrl });
    } else if (chromaDbPath) {
      // chromadb JS v3 no longer supports filesystem paths via `path` (must be http(s) URL).
      chromaDisabled = true;
      console.warn(
        `ChromaDB disabled: CHROMA_DB_PATH="${chromaDbPath}" is not supported in chromadb v3. ` +
          "Set CHROMA_DB_URL (e.g. http://localhost:8001) or Cloud credentials instead.",
      );
      return null;
    } else {
      // Ephemeral (in-memory) - default for development
      console.log("Initializing ChromaDB client in ephemeral (in-memory) mode");
      console.warn("⚠️  ChromaDB is running in-memory. Data will be lost on restart.");
      console.warn("   Set CHROMA_DB_API_KEY, CHROMA_DB_TENANT, CHROMA_DB_DATABASE for ChromaDB Cloud");
      console.warn("   Or set CHROMA_DB_PATH for local persistent storage.");
      chromaClient = new ChromaClient();
    }

    console.log("✅ ChromaDB client initialized successfully");
    return chromaClient;
  } catch (error) {
    console.error("❌ Error initializing ChromaDB:", error);
    throw error;
  }
};

/**
 * Get or create the chat history collection
 * Note: We provide embeddings directly (OpenAI), so no embedding function is needed
 */
const getChatCollection = async () => {
  try {
    if (chatCollection) {
      return chatCollection;
    }

    const client = await initChromaDB();
    
    // Try to get existing collection first
    try {
      chatCollection = await client.getCollection({ name: COLLECTIONS.CHATS });
      console.log(`Chat collection "${COLLECTIONS.CHATS}" retrieved`);
    } catch (e) {
      // Collection doesn't exist, create it without embedding function
      // We provide embeddings directly via OpenAI, so no embedding function needed
      chatCollection = await client.createCollection({
        name: COLLECTIONS.CHATS,
        metadata: {
          description: "Store chat conversations for semantic search",
          "hnsw:space": "cosine", // Use cosine similarity
        },
        // Don't specify embeddingFunction - we provide embeddings directly
      });
      console.log(`Chat collection "${COLLECTIONS.CHATS}" created`);
    }

    return chatCollection;
  } catch (error) {
    console.error("Error getting chat collection:", error);
    throw error;
  }
};

/**
 * Get or create the user sessions collection
 * Note: We provide embeddings directly (OpenAI), so no embedding function is needed
 */
const getSessionCollection = async () => {
  try {
    if (!isChromaConfigured()) {
      return null;
    }
    if (sessionCollection) {
      return sessionCollection;
    }

    const client = await initChromaDB();
    if (!client) return null;
    
    // Try to get existing collection first
    try {
      sessionCollection = await client.getCollection({ name: COLLECTIONS.SESSIONS });
      console.log(`Session collection "${COLLECTIONS.SESSIONS}" retrieved`);
    } catch (e) {
      // Collection doesn't exist, create it without embedding function
      // We provide embeddings directly via OpenAI, so no embedding function needed
      sessionCollection = await client.createCollection({
        name: COLLECTIONS.SESSIONS,
        metadata: {
          description: "Store user coaching sessions for semantic search",
          "hnsw:space": "cosine",
        },
        // Don't specify embeddingFunction - we provide embeddings directly
      });
      console.log(`Session collection "${COLLECTIONS.SESSIONS}" created`);
    }

    return sessionCollection;
  } catch (error) {
    console.error("Error getting session collection:", error);
    throw error;
  }
};

/**
 * Reset collections (useful for testing or fixing embedding function warnings)
 * WARNING: This will delete all data in the collections!
 */
const resetCollections = async () => {
  try {
    const client = await initChromaDB();
    
    // Delete existing collections
    try {
      await client.deleteCollection({ name: COLLECTIONS.CHATS });
      console.log(`Deleted collection: ${COLLECTIONS.CHATS}`);
    } catch (e) {
      // Collection might not exist
      console.log(`Collection ${COLLECTIONS.CHATS} doesn't exist or already deleted`);
    }
    
    try {
      await client.deleteCollection({ name: COLLECTIONS.SESSIONS });
      console.log(`Deleted collection: ${COLLECTIONS.SESSIONS}`);
    } catch (e) {
      // Collection might not exist
      console.log(`Collection ${COLLECTIONS.SESSIONS} doesn't exist or already deleted`);
    }

    // Reset cached references
    chatCollection = null;
    sessionCollection = null;

    // Recreate collections without embedding function (we provide embeddings directly)
    await getChatCollection();
    await getSessionCollection();

    console.log("✅ Collections reset successfully - recreate them without embedding function warnings");
    console.log("⚠️  Note: You'll need to re-sync your data: node src/scripts/syncVectorDB.js");
  } catch (error) {
    console.error("Error resetting collections:", error);
    throw error;
  }
};

/**
 * Get ChromaDB client instance
 */
const getChromaClient = async () => {
  if (!chromaClient) {
    await initChromaDB();
  }
  return chromaClient;
};

module.exports = {
  initChromaDB,
  isChromaConfigured,
  getChromaClient,
  getChatCollection,
  getSessionCollection,
  resetCollections,
  COLLECTIONS,
};
