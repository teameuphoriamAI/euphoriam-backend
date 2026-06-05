/**
 * Vector memory for Stage 1 coach sessions (ChromaDB user_sessions collection).
 * Best-effort — failures do not block coaching.
 */

const { getSessionCollection } = require("../config/chromadb");
const { generateEmbedding } = require("../services/vectorStoreService");

const coachDocId = (sessionId) => `coach_stage1_${sessionId}`;

const formatCoachTranscript = (messages = []) =>
  messages
    .filter((m) => m?.role && m?.content)
    .map((m) => `${m.role}: ${String(m.content).slice(0, 800)}`)
    .join("\n");

/**
 * Upsert ended coach session into Chroma for semantic retrieval.
 */
const indexCoachSession = async ({
  sessionId,
  userId,
  email,
  domain,
  messages = [],
  summary = null,
}) => {
  if (!sessionId || !messages?.length) return null;
  try {
    const collection = await getSessionCollection();
    const transcript = formatCoachTranscript(messages);
    const content = [
      summary ? `Summary: ${summary}` : null,
      `Domain: ${domain || ""}`,
      transcript,
    ]
      .filter(Boolean)
      .join("\n\n")
      .slice(0, 14000);

    const embedding = await generateEmbedding(content);
    const id = coachDocId(sessionId);

    await collection.upsert({
      ids: [id],
      embeddings: [embedding],
      documents: [content],
      metadatas: [
        {
          source: "stage1_coach",
          sessionId: String(sessionId),
          userId: userId ? String(userId) : "",
          email: email || "",
          domain: domain || "",
          messageCount: String(messages.length),
          snippet: (summary || transcript).slice(0, 300),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    return { id };
  } catch (err) {
    console.warn("[indexCoachSession]", err.message);
    return null;
  }
};

const searchCoachSessions = async ({
  userId,
  email,
  domain,
  query,
  topK = 3,
  minScore = 0.25,
}) => {
  if (!query?.trim()) return [];
  try {
    const collection = await getSessionCollection();
    const queryEmbedding = await generateEmbedding(query.slice(0, 2000));
    const where = { source: "stage1_coach" };
    if (userId) where.userId = String(userId);
    if (domain) where.domain = domain;

    const results = await collection.query({
      queryEmbeddings: [queryEmbedding],
      nResults: topK,
      where,
      include: ["metadatas", "documents", "distances"],
    });

    const out = [];
    if (results.ids?.[0]) {
      for (let i = 0; i < results.ids[0].length; i += 1) {
        const similarity = 1 - (results.distances?.[0]?.[i] || 0);
        if (similarity < minScore) continue;
        out.push({
          session_id: results.metadatas?.[0]?.[i]?.sessionId || null,
          domain: results.metadatas?.[0]?.[i]?.domain || null,
          snippet: results.metadatas?.[0]?.[i]?.snippet || null,
          similarity: Math.round(similarity * 100) / 100,
        });
      }
    }
    return out;
  } catch (err) {
    console.warn("[searchCoachSessions]", err.message);
    return [];
  }
};

module.exports = {
  indexCoachSession,
  searchCoachSessions,
  coachDocId,
};
