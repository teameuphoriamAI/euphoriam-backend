const { getChatCollection, getSessionCollection } = require("../config/chromadb");
const openai = require("../config/openai");
const { Chat } = require("../models/chatModel");
const { UserSession } = require("../models/userSessionModel");
const { Op } = require("sequelize");

/**
 * Generate embeddings for text using OpenAI
 * @param {string} text - Text to embed
 * @returns {Promise<number[]>} Embedding vector
 */
const generateEmbedding = async (text) => {
  try {
    if (!text || typeof text !== "string" || text.trim().length === 0) {
      throw new Error("Text must be a non-empty string");
    }

    // Truncate text if too long (max ~8000 tokens for text-embedding-3-small)
    const maxChars = 30000; // ~7500 tokens
    const truncatedText = text.length > maxChars ? text.slice(0, maxChars) : text;

    const response = await openai.embeddings.create({
      model: "text-embedding-3-small",
      input: truncatedText,
    });

    return response.data?.[0]?.embedding || [];
  } catch (error) {
    console.error("Error generating embedding:", error);
    throw error;
  }
};

/**
 * Format chat transcript into a searchable string
 * @param {Array} transcript - Array of chat messages
 * @returns {string} Formatted transcript string
 */
const formatTranscript = (transcript) => {
  if (!Array.isArray(transcript)) return "";
  
  return transcript
    .map((msg) => {
      const role = msg.role === "assistant" ? "Euphoriam" : "User";
      return `${role}: ${msg.content || ""}`;
    })
    .join("\n");
};

/**
 * Chunk transcript into multiple parts that fit within size limits
 * Each chunk will be stored as a separate document in ChromaDB
 * @param {Array} transcript - Full chat transcript
 * @param {number} maxBytesPerChunk - Maximum bytes per chunk (default: 14000)
 * @returns {Array} Array of chunk objects with messages and formatted text
 */
const chunkTranscript = (transcript, maxBytesPerChunk = 14000) => {
  if (!transcript || transcript.length === 0) {
    return [];
  }

  const chunks = [];
  let currentChunk = [];
  let currentSize = 0;
  
  // Header size (will be added to each chunk)
  const headerSize = Buffer.byteLength("Chat Type: diagnostic\nDate: \n\nConversation:\n", 'utf8');
  const maxContentSize = maxBytesPerChunk - headerSize - 500; // Leave room for header and metadata

  for (const message of transcript) {
    const formattedMessage = formatTranscript([message]);
    const messageSize = Buffer.byteLength(formattedMessage, 'utf8');

    // If adding this message would exceed the limit, start a new chunk
    if (currentSize + messageSize > maxContentSize && currentChunk.length > 0) {
      chunks.push({
        messages: [...currentChunk],
        formatted: formatTranscript(currentChunk),
      });
      currentChunk = [];
      currentSize = 0;
    }

    currentChunk.push(message);
    currentSize += messageSize;
  }

  // Add the last chunk if it has messages
  if (currentChunk.length > 0) {
    chunks.push({
      messages: [...currentChunk],
      formatted: formatTranscript(currentChunk),
    });
  }

  return chunks;
};

/**
 * Create a chunk summary for embedding
 * @param {string} formattedTranscript - Formatted transcript chunk
 * @param {Object} metadata - Additional metadata
 * @param {number} chunkIndex - Index of this chunk (0-based)
 * @param {number} totalChunks - Total number of chunks
 * @returns {string} Summary text for embedding
 */
const createChatChunkSummary = (formattedTranscript, metadata = {}, chunkIndex = 0, totalChunks = 1) => {
  const chatType = metadata.chatType || "diagnostic";
  const date = metadata.date ? new Date(metadata.date).toLocaleDateString() : "";
  
  // Extract key topics from user messages in this chunk
  const userMessages = formattedTranscript
    .split('\n')
    .filter(line => line.startsWith('User:'))
    .map(line => line.replace('User:', '').trim())
    .join(' ');

  const chunkInfo = totalChunks > 1 ? ` (Part ${chunkIndex + 1} of ${totalChunks})` : '';
  
  return `Chat Type: ${chatType}${chunkInfo}\nDate: ${date}\n\nConversation:\n${formattedTranscript}\n\nUser Topics: ${userMessages.slice(0, 500)}`;
};

// ================== CHAT VECTOR OPERATIONS ==================

/**
 * Store a chat conversation in the vector database
 * @param {Object} params - Chat parameters
 * @param {number} params.chatId - Unique chat ID
 * @param {number} params.userId - User ID
 * @param {Array} params.transcript - Chat transcript
 * @param {string} params.chatType - Type of chat (diagnostic/discovery)
 * @param {Object} params.metadata - Additional metadata
 */
const storeChatInVectorDB = async ({ chatId, userId, transcript, chatType, metadata = {} }) => {
  try {
    if (!transcript || transcript.length === 0) {
      console.log("No transcript to store");
      return null;
    }

    const collection = await getChatCollection();

    // Convert Date objects to ISO strings
    const createdAt = metadata.createdAt 
      ? (metadata.createdAt instanceof Date ? metadata.createdAt.toISOString() : String(metadata.createdAt))
      : new Date().toISOString();

    // Chunk the FULL transcript into multiple documents (each under 16KB)
    // This allows us to store the entire chat while staying within ChromaDB Cloud limits
    const chunks = chunkTranscript(transcript, 14000);
    
    if (chunks.length === 0) {
      console.log("No chunks to store");
      return null;
    }

    // Prepare all chunks for batch upsert
    const ids = [];
    const embeddings = [];
    const metadatas = [];
    const documents = [];

    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      
      // Create content for this chunk
      let content = createChatChunkSummary(
        chunk.formatted,
        { chatType, date: metadata.createdAt },
        i,
        chunks.length
      );

      // Verify content size
      const contentBytes = Buffer.byteLength(content, 'utf8');
      if (contentBytes > 15000) {
        console.warn(`[storeChatInVectorDB] Chunk ${i} still too large (${contentBytes} bytes), truncating`);
        content = content.slice(0, 14000);
      }

      // Generate embedding for this chunk
      const embedding = await generateEmbedding(content);

      // Unique ID for this chunk (includes chunk index for multi-chunk chats)
      const id = chunks.length > 1 ? `chat_${chatId}_chunk_${i}` : `chat_${chatId}`;

      // Metadata for this chunk
      const docMetadata = {
        chatId: String(chatId),
        userId: String(userId),
        chatType: chatType || "diagnostic",
        messageCount: String(transcript.length), // Total messages in full chat
        chunkIndex: String(i),
        totalChunks: String(chunks.length),
        chunkMessageCount: String(chunk.messages.length), // Messages in this chunk
        createdAt: createdAt,
        updatedAt: new Date().toISOString(),
        // Store snippet from this chunk
        snippet: chunk.formatted.slice(0, 300),
      };

      ids.push(id);
      embeddings.push(embedding);
      metadatas.push(docMetadata);
      documents.push(content);
    }

    // Batch upsert all chunks
    await collection.upsert({
      ids: ids,
      embeddings: embeddings,
      metadatas: metadatas,
      documents: documents,
    });

    console.log(`Stored FULL chat ${chatId} in vector DB (${transcript.length} messages, ${chunks.length} chunk(s))`);
    return { id: `chat_${chatId}`, chatId, userId, chunks: chunks.length };
  } catch (error) {
    console.error("Error storing chat in vector DB:", error);
    throw error;
  }
};

/**
 * Search for similar past chats
 * Tries vector DB first, falls back to PostgreSQL if vector DB fails
 * @param {Object} params - Search parameters
 * @param {string} params.query - Search query
 * @param {number} params.userId - User ID to filter by
 * @param {string} params.chatType - Filter by chat type
 * @param {number} params.topK - Number of results to return
 * @param {number} params.minScore - Minimum similarity score (0-1)
 */
const searchChats = async ({ query, userId, chatType, topK = 5, minScore = 0.3 }) => {
  // Try vector DB first (preferred method)
  try {
    const collection = await getChatCollection();

    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query);

    // Build where filter
    const whereFilter = {};
    if (userId) {
      whereFilter.userId = String(userId);
    }
    if (chatType) {
      whereFilter.chatType = chatType;
    }

    // Query ChromaDB
    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      where: Object.keys(whereFilter).length > 0 ? whereFilter : undefined,
      include: ["metadatas", "documents", "distances"],
    });

    // Format results and deduplicate by chatId (multiple chunks from same chat)
    const chatMap = new Map(); // chatId -> best result
    
    if (results.ids?.[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        // ChromaDB returns distances, convert to similarity score
        // For cosine distance: similarity = 1 - distance
        const distance = results.distances?.[0]?.[i] || 0;
        const similarity = 1 - distance;

        if (similarity >= minScore) {
          const chatId = results.metadatas?.[0]?.[i]?.chatId;
          const existing = chatMap.get(chatId);
          
          // Keep the chunk with highest similarity for each chat
          if (!existing || similarity > existing.similarity) {
            chatMap.set(chatId, {
              id: results.ids[0][i],
              chatId: chatId,
              userId: results.metadatas?.[0]?.[i]?.userId,
              chatType: results.metadatas?.[0]?.[i]?.chatType,
              messageCount: results.metadatas?.[0]?.[i]?.messageCount,
              chunkIndex: results.metadatas?.[0]?.[i]?.chunkIndex,
              totalChunks: results.metadatas?.[0]?.[i]?.totalChunks,
              snippet: results.metadatas?.[0]?.[i]?.snippet,
              createdAt: results.metadatas?.[0]?.[i]?.createdAt,
              content: results.documents?.[0]?.[i],
              similarity: similarity,
              source: "vectordb",
            });
          }
        }
      }
    }

    // Convert map to array and sort by similarity
    const formattedResults = Array.from(chatMap.values())
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, topK);

    console.log(`[searchChats] Vector DB - Found ${formattedResults.length} unique chats (from ${results.ids?.[0]?.length || 0} chunks)`);
    return formattedResults;
  } catch (vectorError) {
    console.warn(`[searchChats] Vector DB failed, falling back to PostgreSQL:`, vectorError.message);
    
    // Fallback to PostgreSQL search
    try {
      const fallbackResults = await searchChatsPostgreSQL({ query, userId, chatType, topK });
      console.log(`[searchChats] PostgreSQL fallback - Found ${fallbackResults.length} chats`);
      return fallbackResults;
    } catch (pgError) {
      console.error("[searchChats] Both vector DB and PostgreSQL search failed:", pgError);
      throw new Error("Search failed: Vector DB and PostgreSQL fallback both failed");
    }
  }
};

/**
 * Delete a chat from the vector database
 * Deletes all chunks associated with the chat
 * @param {number} chatId - Chat ID to delete
 */
const deleteChatFromVectorDB = async (chatId) => {
  try {
    const collection = await getChatCollection();
    
    // Delete by chatId metadata (this will delete all chunks)
    // ChromaDB supports deleting by metadata filter
    await collection.delete({
      where: {
        chatId: String(chatId),
      },
    });
    
    console.log(`Deleted chat ${chatId} and all its chunks from vector DB`);
  } catch (error) {
    // Fallback: try deleting by ID pattern if metadata delete fails
    try {
      const collection = await getChatCollection();
      // Try to get all chunks for this chat
      const results = await collection.get({
        where: { chatId: String(chatId) },
      });
      
      if (results.ids && results.ids.length > 0) {
        await collection.delete({ ids: results.ids });
        console.log(`Deleted chat ${chatId} (${results.ids.length} chunks) from vector DB`);
      }
    } catch (fallbackError) {
      console.error("Error deleting chat from vector DB:", error);
      throw error;
    }
  }
};

// ================== USER SESSION VECTOR OPERATIONS ==================

/**
 * Store a user session in the vector database
 * @param {Object} params - Session parameters
 * @param {number} params.sessionId - Unique session ID
 * @param {number} params.userId - User ID
 * @param {string} params.email - User email
 * @param {Array} params.transcript - Session transcript
 * @param {string} params.summary - Session summary
 * @param {Object} params.metadata - Additional metadata
 */
const storeSessionInVectorDB = async ({ sessionId, userId, email, transcript, summary, metadata = {} }) => {
  try {
    if (!transcript || transcript.length === 0) {
      console.log("No transcript to store for session");
      return null;
    }

    const collection = await getSessionCollection();

    // Create searchable content combining summary and transcript
    // Optimize for ChromaDB Cloud's 16KB limit (use 14KB max)
    const maxBytes = 14000;
    
    // Limit transcript to recent messages (last 100) for better relevance
    const recentTranscript = transcript.slice(-100);
    const transcriptText = formatTranscript(recentTranscript);
    
    // Build content prioritizing summary if available
    let content = summary 
      ? `Session Summary:\n${summary}\n\nTranscript:\n${transcriptText}`
      : transcriptText;
    
    // Truncate if too large
    const contentBytes = Buffer.byteLength(content, 'utf8');
    if (contentBytes > maxBytes) {
      if (summary) {
        // If we have a summary, prioritize it and truncate transcript
        const summaryBytes = Buffer.byteLength(summary, 'utf8');
        const availableForTranscript = maxBytes - summaryBytes - 100; // Leave room for headers
        
        if (availableForTranscript > 0) {
          const truncatedTranscript = transcriptText.slice(0, availableForTranscript);
          content = `Session Summary:\n${summary}\n\nTranscript:\n${truncatedTranscript}`;
        } else {
          // Summary alone is too large, truncate it
          content = `Session Summary:\n${summary.slice(0, maxBytes - 50)}\n\nTranscript:\n[Truncated]`;
        }
      } else {
        // No summary, just truncate transcript
        content = transcriptText.slice(0, maxBytes);
      }
    }

    // Generate embedding
    const embedding = await generateEmbedding(content);

    // Unique ID for this session entry
    const id = `session_${sessionId}`;

    // Convert Date objects to ISO strings (ChromaDB requires strings, numbers, booleans, or arrays)
    const sessionDate = metadata.sessionDate
      ? (metadata.sessionDate instanceof Date ? metadata.sessionDate.toISOString() : String(metadata.sessionDate))
      : new Date().toISOString();
    
    const createdAt = metadata.createdAt
      ? (metadata.createdAt instanceof Date ? metadata.createdAt.toISOString() : String(metadata.createdAt))
      : new Date().toISOString();

    // Metadata to store (keep small to stay within limits)
    const docMetadata = {
      sessionId: String(sessionId),
      userId: userId ? String(userId) : "",
      email: email || "",
      messageCount: String(transcript.length),
      sessionDate: sessionDate,
      createdAt: createdAt,
      updatedAt: new Date().toISOString(),
      hasSummary: summary ? "true" : "false",
      snippet: (summary || formatTranscript(transcript.slice(-10))).slice(0, 300), // Last 10 messages, max 300 chars
    };

    // Upsert to ChromaDB
    await collection.upsert({
      ids: [id],
      embeddings: [embedding],
      metadatas: [docMetadata],
      documents: [content],
    });

    console.log(`Stored session ${sessionId} in vector DB (${transcript.length} messages, content: ${Buffer.byteLength(content, 'utf8')} bytes)`);
    return { id, sessionId, userId };
  } catch (error) {
    console.error("Error storing session in vector DB:", error);
    throw error;
  }
};

/**
 * Search for similar past sessions
 * Tries vector DB first, falls back to PostgreSQL if vector DB fails
 * @param {Object} params - Search parameters
 * @param {string} params.query - Search query
 * @param {number} params.userId - User ID to filter by
 * @param {string} params.email - Email to filter by
 * @param {number} params.topK - Number of results to return
 * @param {number} params.minScore - Minimum similarity score
 */
const searchSessions = async ({ query, userId, email, topK = 5, minScore = 0.3 }) => {
  // Try vector DB first (preferred method)
  try {
    const collection = await getSessionCollection();

    // Generate embedding for the query
    const queryEmbedding = await generateEmbedding(query);

    // Build where filter
    const whereFilter = {};
    if (userId) {
      whereFilter.userId = String(userId);
    }
    if (email) {
      whereFilter.email = email;
    }

    // Query ChromaDB
    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      where: Object.keys(whereFilter).length > 0 ? whereFilter : undefined,
      include: ["metadatas", "documents", "distances"],
    });

    // Format results
    const formattedResults = [];
    if (results.ids?.[0]) {
      for (let i = 0; i < results.ids[0].length; i++) {
        const distance = results.distances?.[0]?.[i] || 0;
        const similarity = 1 - distance;

        if (similarity >= minScore) {
          formattedResults.push({
            id: results.ids[0][i],
            sessionId: results.metadatas?.[0]?.[i]?.sessionId,
            userId: results.metadatas?.[0]?.[i]?.userId,
            email: results.metadatas?.[0]?.[i]?.email,
            messageCount: results.metadatas?.[0]?.[i]?.messageCount,
            sessionDate: results.metadatas?.[0]?.[i]?.sessionDate,
            snippet: results.metadatas?.[0]?.[i]?.snippet,
            content: results.documents?.[0]?.[i],
            similarity: similarity,
            source: "vectordb",
          });
        }
      }
    }

    console.log(`[searchSessions] Vector DB - Found ${formattedResults.length} similar sessions`);
    return formattedResults;
  } catch (vectorError) {
    console.warn(`[searchSessions] Vector DB failed, falling back to PostgreSQL:`, vectorError.message);
    
    // Fallback to PostgreSQL search
    try {
      const fallbackResults = await searchSessionsPostgreSQL({ query, userId, email, topK });
      console.log(`[searchSessions] PostgreSQL fallback - Found ${fallbackResults.length} sessions`);
      return fallbackResults;
    } catch (pgError) {
      console.error("[searchSessions] Both vector DB and PostgreSQL search failed:", pgError);
      throw new Error("Search failed: Vector DB and PostgreSQL fallback both failed");
    }
  }
};

/**
 * Delete a session from the vector database
 * @param {number} sessionId - Session ID to delete
 */
const deleteSessionFromVectorDB = async (sessionId) => {
  try {
    const collection = await getSessionCollection();
    const id = `session_${sessionId}`;
    
    await collection.delete({ ids: [id] });
    console.log(`Deleted session ${sessionId} from vector DB`);
  } catch (error) {
    console.error("Error deleting session from vector DB:", error);
    throw error;
  }
};

// ================== UNIFIED SEARCH ==================

/**
 * Search across both chats and sessions for comprehensive context retrieval
 * Automatically uses fallback if vector DB fails
 * @param {Object} params - Search parameters
 * @param {string} params.query - Search query
 * @param {number} params.userId - User ID to filter by
 * @param {number} params.topK - Number of results per collection
 * @param {number} params.minScore - Minimum similarity score
 */
const searchAllHistory = async ({ query, userId, topK = 3, minScore = 0.3 }) => {
  // searchChats and searchSessions already have fallback logic built-in
  try {
    const [chatResults, sessionResults] = await Promise.all([
      searchChats({ query, userId, topK, minScore }).catch(() => []),
      searchSessions({ query, userId, topK, minScore }).catch(() => []),
    ]);

    // Combine and sort by similarity
    const combined = [
      ...chatResults.map((r) => ({ ...r, type: "chat" })),
      ...sessionResults.map((r) => ({ ...r, type: "session" })),
    ].sort((a, b) => b.similarity - a.similarity);

    return {
      chats: chatResults,
      sessions: sessionResults,
      combined: combined.slice(0, topK * 2),
    };
  } catch (error) {
    console.error("Error searching all history:", error);
    // Try PostgreSQL fallback as last resort
    return await searchAllHistoryPostgreSQL({ query, userId, topK });
  }
};

// ================== POSTGRESQL FALLBACK FUNCTIONS ==================

/**
 * Fallback: Search chats in PostgreSQL using text search
 * Used when ChromaDB is unavailable
 */
const searchChatsPostgreSQL = async ({ query, userId, chatType, topK = 5 }) => {
  try {
    const searchTerms = query.toLowerCase().split(/\s+/).filter(term => term.length > 2);
    
    const whereClause = {
      userId: userId,
    };

    if (chatType) {
      whereClause.chatType = chatType;
    }

    // Get recent chats
    const chats = await Chat.findAll({
      where: whereClause,
      order: [["createdAt", "DESC"]],
      limit: topK * 3, // Get more to filter by relevance
    });

    // Score chats by keyword matches in transcript
    const scoredChats = chats.map(chat => {
      const transcript = chat.data?.transcript || [];
      const transcriptText = formatTranscript(transcript).toLowerCase();
      
      // Count keyword matches
      let score = 0;
      searchTerms.forEach(term => {
        const matches = (transcriptText.match(new RegExp(term, "gi")) || []).length;
        score += matches;
      });

      // Boost score for recent chats
      const daysSince = (Date.now() - new Date(chat.createdAt).getTime()) / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.max(0, 1 - (daysSince / 90)); // Decay over 90 days
      score += recencyBoost * 2;

      return { chat, score };
    }).filter(item => item.score > 0) // Only include chats with matches
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scoredChats.map(({ chat, score }) => ({
      id: `chat_${chat.id}`,
      chatId: String(chat.id),
      userId: String(chat.userId),
      chatType: chat.chatType,
      messageCount: String((chat.data?.transcript || []).length),
      snippet: formatTranscript((chat.data?.transcript || []).slice(0, 5)).slice(0, 500),
      createdAt: chat.createdAt.toISOString(),
      similarity: Math.min(0.9, score / 10), // Normalize to 0-0.9 range
      source: "postgresql",
    }));
  } catch (error) {
    console.error("Error in PostgreSQL chat search fallback:", error);
    return [];
  }
};

/**
 * Fallback: Search sessions in PostgreSQL using text search
 * Used when ChromaDB is unavailable
 */
const searchSessionsPostgreSQL = async ({ query, userId, email, topK = 5 }) => {
  try {
    const searchTerms = query.toLowerCase().split(/\s+/).filter(term => term.length > 2);
    
    const whereClause = {};
    if (userId) {
      whereClause.userId = userId;
    }
    if (email) {
      whereClause.email = email;
    }

    // Get recent sessions
    const sessions = await UserSession.findAll({
      where: whereClause,
      order: [["sessionDate", "DESC"], ["createdAt", "DESC"]],
      limit: topK * 3,
    });

    // Score sessions by keyword matches
    const scoredSessions = sessions.map(session => {
      const transcript = session.transcript || [];
      const transcriptText = formatTranscript(transcript).toLowerCase();
      const summaryText = (session.summery || "").toLowerCase();
      const combinedText = `${summaryText} ${transcriptText}`;
      
      // Count keyword matches
      let score = 0;
      searchTerms.forEach(term => {
        const transcriptMatches = (transcriptText.match(new RegExp(term, "gi")) || []).length;
        const summaryMatches = (summaryText.match(new RegExp(term, "gi")) || []).length;
        score += transcriptMatches + (summaryMatches * 2); // Summary matches weighted higher
      });

      // Boost score for recent sessions
      const sessionDate = session.sessionDate || session.createdAt;
      const daysSince = (Date.now() - new Date(sessionDate).getTime()) / (1000 * 60 * 60 * 24);
      const recencyBoost = Math.max(0, 1 - (daysSince / 90));
      score += recencyBoost * 2;

      return { session, score };
    }).filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, topK);

    return scoredSessions.map(({ session, score }) => ({
      id: `session_${session.id}`,
      sessionId: String(session.id),
      userId: session.userId ? String(session.userId) : "",
      email: session.email || "",
      messageCount: String((session.transcript || []).length),
      sessionDate: session.sessionDate ? session.sessionDate.toISOString() : session.createdAt.toISOString(),
      snippet: (session.summery || formatTranscript(session.transcript || []).slice(0, 500)).slice(0, 500),
      similarity: Math.min(0.9, score / 10),
      source: "postgresql",
    }));
  } catch (error) {
    console.error("Error in PostgreSQL session search fallback:", error);
    return [];
  }
};

/**
 * Fallback: Search all history using PostgreSQL
 */
const searchAllHistoryPostgreSQL = async ({ query, userId, topK = 3 }) => {
  try {
    const [chatResults, sessionResults] = await Promise.all([
      searchChatsPostgreSQL({ query, userId, topK }),
      searchSessionsPostgreSQL({ query, userId, topK }),
    ]);

    const combined = [
      ...chatResults.map((r) => ({ ...r, type: "chat" })),
      ...sessionResults.map((r) => ({ ...r, type: "session" })),
    ].sort((a, b) => b.similarity - a.similarity);

    return {
      chats: chatResults,
      sessions: sessionResults,
      combined: combined.slice(0, topK * 2),
    };
  } catch (error) {
    console.error("Error in PostgreSQL search fallback:", error);
    return {
      chats: [],
      sessions: [],
      combined: [],
    };
  }
};

/**
 * Get relevant context for chatbot based on user query
 * Tries vector DB first, falls back to PostgreSQL if vector DB fails
 * @param {Object} params - Parameters
 * @param {string} params.query - User's current message
 * @param {number} params.userId - User ID
 * @param {number} params.topK - Number of relevant items to retrieve
 */
const getRelevantContext = async ({ query, userId, topK = 3 }) => {
  let results = null;
  let usedVectorDB = false;

  // Try vector DB first (preferred method)
  try {
    results = await searchAllHistory({ query, userId, topK, minScore: 0.4 });
    usedVectorDB = true;
    console.log(`[getRelevantContext] Used vector DB - found ${results.combined.length} results`);
  } catch (vectorError) {
    console.warn(`[getRelevantContext] Vector DB search failed, falling back to PostgreSQL:`, vectorError.message);
    
    // Fallback to PostgreSQL search
    try {
      results = await searchAllHistoryPostgreSQL({ query, userId, topK });
      console.log(`[getRelevantContext] Used PostgreSQL fallback - found ${results.combined.length} results`);
    } catch (pgError) {
      console.error("[getRelevantContext] Both vector DB and PostgreSQL search failed:", pgError);
      results = {
        chats: [],
        sessions: [],
        combined: [],
      };
    }
  }

  // Format context for inclusion in chatbot prompt
  let context = "";

  if (results.chats.length > 0) {
    context += "### Relevant Past Conversations:\n";
    results.chats.forEach((chat, i) => {
      const source = chat.source === "postgresql" ? " (keyword search)" : "";
      context += `\n**Conversation ${i + 1}** (${chat.chatType}, ${chat.createdAt})${source}:\n`;
      context += `${chat.snippet}\n`;
    });
  }

  if (results.sessions.length > 0) {
    context += "\n### Relevant Coaching Sessions:\n";
    results.sessions.forEach((session, i) => {
      const source = session.source === "postgresql" ? " (keyword search)" : "";
      context += `\n**Session ${i + 1}** (${session.sessionDate})${source}:\n`;
      context += `${session.snippet}\n`;
    });
  }

  return {
    context: context.trim(),
    hasRelevantHistory: results.combined.length > 0,
    resultCount: results.combined.length,
    results: results,
    usedVectorDB: usedVectorDB,
  };
};

module.exports = {
  // Embedding
  generateEmbedding,
  formatTranscript,
  
  // Chat operations
  storeChatInVectorDB,
  searchChats,
  deleteChatFromVectorDB,
  
  // Session operations
  storeSessionInVectorDB,
  searchSessions,
  deleteSessionFromVectorDB,
  
  // Unified operations
  searchAllHistory,
  getRelevantContext,
  
  // PostgreSQL fallback functions (for when vector DB is unavailable)
  searchChatsPostgreSQL,
  searchSessionsPostgreSQL,
  searchAllHistoryPostgreSQL,
};
