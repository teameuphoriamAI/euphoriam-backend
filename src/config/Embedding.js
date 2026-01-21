const { OpenAIEmbeddings } = require("@langchain/openai");
const { CacheBackedEmbeddings } = require("@langchain/classic/embeddings/cache_backed");
const { InMemoryStore } = require("@langchain/core/stores");

const underlyingEmbeddings = new OpenAIEmbeddings({
  apiKey: process.env.OPENAI_API_KEY,
});

const inMemoryStore = new InMemoryStore();

const cacheBackedEmbeddings = CacheBackedEmbeddings.fromBytesStore(
  underlyingEmbeddings,
  inMemoryStore,
  { namespace: underlyingEmbeddings.model }
);

/**
 * Estimate token count (rough approximation: ~4 characters per token for English)
 * @param {string} text - Text to estimate tokens for
 * @returns {number} Estimated token count
 */
const estimateTokens = (text) => {
  if (!text || typeof text !== "string") return 0;
  // Rough approximation: 1 token ≈ 4 characters for English text
  return Math.ceil(text.length / 4);
};

/**
 * Split text into chunks that fit within token limit
 * @param {string} text - Text to chunk
 * @param {number} maxTokens - Maximum tokens per chunk (default: 6000, safely under 8192 limit)
 * @returns {string[]} Array of text chunks
 */
const chunkText = (text, maxTokens = 6000) => {
  if (!text || typeof text !== "string") return [text || ""];
  
  const estimatedTokens = estimateTokens(text);
  
  // If text fits within limit, return as single chunk
  if (estimatedTokens <= maxTokens) {
    return [text];
  }

  // Calculate approximate characters per chunk
  const charsPerChunk = maxTokens * 4;
  const chunks = [];
  let currentIndex = 0;

  while (currentIndex < text.length) {
    let chunkEnd = currentIndex + charsPerChunk;
    
    // If this is the last chunk, take the rest
    if (chunkEnd >= text.length) {
      chunks.push(text.slice(currentIndex));
      break;
    }

    // Try to break at a newline or sentence boundary for better chunking
    const chunkText = text.slice(currentIndex, chunkEnd);
    const lastNewline = chunkText.lastIndexOf("\n");
    const lastPeriod = chunkText.lastIndexOf(". ");
    const lastSpace = chunkText.lastIndexOf(" ");

    // Prefer breaking at newline, then period, then space
    let breakPoint = lastNewline > chunkText.length * 0.8 ? lastNewline :
                     lastPeriod > chunkText.length * 0.8 ? lastPeriod :
                     lastSpace > chunkText.length * 0.8 ? lastSpace :
                     chunkEnd - currentIndex;

    chunks.push(text.slice(currentIndex, currentIndex + breakPoint).trim());
    currentIndex += breakPoint;
    
    // Skip whitespace at the start of next chunk
    while (currentIndex < text.length && /\s/.test(text[currentIndex])) {
      currentIndex++;
    }
  }

  return chunks.filter(chunk => chunk.length > 0);
};

/**
 * Average multiple embeddings into a single embedding vector
 * @param {number[][]} embeddings - Array of embedding vectors
 * @returns {number[]} Averaged embedding vector
 */
const averageEmbeddings = (embeddings) => {
  if (!embeddings || embeddings.length === 0) return [];
  if (embeddings.length === 1) return embeddings[0];

  const dimension = embeddings[0].length;
  const averaged = new Array(dimension).fill(0);

  for (const embedding of embeddings) {
    for (let i = 0; i < dimension; i++) {
      averaged[i] += embedding[i];
    }
  }

  // Divide by number of embeddings to get average
  for (let i = 0; i < dimension; i++) {
    averaged[i] /= embeddings.length;
  }

  return averaged;
};

/**
 * Create embeddings for a document, handling long texts by chunking
 * @param {string} document - Document text to embed
 * @param {Object} options - Options for embedding
 * @param {boolean} options.returnChunks - If true, return array of embeddings; if false, return averaged embedding
 * @returns {Promise<number[]|number[][]>} Single embedding vector or array of embedding vectors
 */
const createEmbeddings = async (document, options = {}) => {
  try {
    const { returnChunks = false } = options;
    const tic = Date.now();

    if (!document || typeof document !== "string") {
      throw new Error("Document must be a non-empty string");
    }

    // Chunk the document if it's too long
    const chunks = chunkText(document);
    
    console.log(`Creating embeddings for ${chunks.length} chunk(s) (estimated ${estimateTokens(document)} tokens total)`);

    // Create embeddings for all chunks
    const chunkEmbeddings = await cacheBackedEmbeddings.embedDocuments(chunks);

    if (returnChunks) {
      // Return array of embeddings (one per chunk)
      console.log(`Embeddings generated in ${Date.now() - tic}ms (${chunkEmbeddings.length} chunks)`);
      return chunkEmbeddings;
    } else {
      // Average all chunk embeddings into a single vector
      const averagedEmbedding = averageEmbeddings(chunkEmbeddings);
      console.log(`Embeddings generated in ${Date.now() - tic}ms (${chunks.length} chunks averaged)`);
      return averagedEmbedding;
    }
  } catch (error) {
    console.error("Error creating embeddings:", error);
    throw error;
  }
};

module.exports = { createEmbeddings };
