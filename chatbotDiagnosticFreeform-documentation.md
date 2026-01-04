# `chatbotDiagnosticFreeform` Function Documentation

## Overview

The `chatbotDiagnosticFreeform` function is the core API endpoint that powers Euphoriam AI's diagnostic chatbot system. It handles both **diagnostic intake** (first-time users) and **discovery chat** (returning users with existing reports) modes, orchestrating conversations, generating AI-powered diagnostic reports, creating PDFs, and managing user state.

**Location:** `src/controllers/diagnosticController.js` (lines 564-1479)

**Function Signature:**
```javascript
const chatbotDiagnosticFreeform = async (req, res) => { ... }
```

---

## Input Parameters

The function expects the following parameters in `req.body`:

| Parameter | Type | Required | Default | Description |
|-----------|------|----------|---------|-------------|
| `email` | string | ✅ Yes | - | User's email address (used for Kajabi integration and user identification) |
| `name` | string | ✅ Yes | - | User's name |
| `messages` | array | No | `[]` | Conversation transcript (array of `{role: "user"|"assistant", content: string}`) |
| `assessmentIds` | array | No | `[]` | Kajabi assessment IDs for context |
| `finalize` | boolean | No | `false` | If `true`, generates final diagnostic report immediately |
| `introPageText` | string | No | `DEFAULT_INTRO_PAGE_TEXT` | Custom intro page text for the diagnostic report |
| `targetCount` | number | No | `12` | Target number of intake questions (reduced to 6 for discovery mode) |

---

## Main Flow Overview

The function operates in two primary modes:

1. **Diagnostic Mode** (`finalize = false` and no existing report): Structured Q&A intake session
2. **Discovery Mode** (`hasExistingReport = true`): Freeform conversational chat for returning users

### High-Level Flow Diagram

```
┌─────────────────────────────────────────────────────────────┐
│                    Request Received                          │
└──────────────────────┬──────────────────────────────────────┘
                       │
                       ▼
            ┌───────────────────────┐
            │  Validate Inputs      │
            │  (email, name)        │
            └───────────┬───────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │  Load Existing State   │
            │  - Diagnostic record  │
            │  - Intake state        │
            │  - Previous reports   │
            └───────────┬───────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │  Determine Mode        │
            │  - Diagnostic?         │
            │  - Discovery?          │
            └───────────┬───────────┘
                        │
        ┌───────────────┴───────────────┐
        │                                 │
        ▼                                 ▼
┌───────────────┐              ┌───────────────┐
│ Diagnostic    │              │ Discovery     │
│ Mode          │              │ Mode          │
│               │              │               │
│ - Q&A Intake  │              │ - Freeform    │
│ - Track Q#    │              │ - Reference   │
│ - Progress    │              │   prior report │
└───────┬───────┘              └───────┬───────┘
        │                               │
        └───────────────┬───────────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │  Build Kajabi Context │
            │  - Customer data      │
            │  - Products/Offers    │
            │  - Assessments        │
            │  - Metrics            │
            └───────────┬───────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │  RAG Retrieval         │
            │  (Similar chunks)      │
            └───────────┬───────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │  Build AI Prompts     │
            │  - System prompt      │
            │  - User prompt        │
            └───────────┬───────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │  Call OpenAI API      │
            │  - GPT-5.2 model      │
            │  - Temperature varies │
            │  - Token limits       │
            └───────────┬───────────┘
                        │
                        ▼
            ┌───────────────────────┐
            │  Process Response      │
            │  - Clean numbered Qs  │
            │  - Add resume notice  │
            │  - Handle empty resp   │
            └───────────┬───────────┘
                        │
                        ▼
        ┌───────────────────────────────┐
        │  Check Completion Criteria    │
        │  - All questions answered?     │
        │  - finalize = true?           │
        └───────────┬───────────────────┘
                    │
        ┌───────────┴───────────┐
        │                       │
        ▼                       ▼
┌───────────────┐      ┌───────────────┐
│ Continue Chat │      │ Generate      │
│ - Save state  │      │ Report        │
│ - Return msg  │      │ - AI report   │
└───────────────┘      │ - PDF         │
                       │ - Email       │
                       └───────────────┘
```

---

## Detailed Function Breakdown

### 1. Initialization & Validation (Lines 565-620)

```javascript
const {
  email,
  name,
  messages = [],
  assessmentIds = [],
  finalize = false,
  introPageText,
  targetCount = 12,
} = req.body || {};

// Validation
if (!email) return errorResponse(res, "Email is required", 400);
if (!name) return errorResponse(res, "Name is required", 400);
```

**What happens:**
- Extracts and validates required parameters
- Loads existing diagnostic record from database (if any)
- Retrieves existing intake state, report, and previous reports
- Handles resume logic for returning users
- Short-circuits if `finalize=true` and report already exists (prevents duplicate emails)

**Key Variables Created:**
- `existingDiagnostic`: Database record for this email
- `existingState`: Previous intake state (`transcript`, `acceptedAnswers`, etc.)
- `existingReport`: Previously generated AI report text
- `priorReportSnippet`: Truncated version (12,000 chars) for context
- `previousReports`: Array of historical reports
- `hasExistingReport`: Boolean flag determining mode

---

### 2. Transcript Management (Lines 622-652)

```javascript
const useExistingTranscript = !hasExistingReport && 
  Array.isArray(existingState.transcript) && 
  existingState.transcript.length;

const transcript = Array.isArray(messages) && messages.length
  ? messages
  : useExistingTranscript
  ? existingState.transcript
  : [];
```

**What happens:**
- Prioritizes request transcript over stored state
- For completed diagnostics, starts fresh discovery transcript (doesn't reuse intake)
- Calculates progress metrics:
  - `answered`: Count of user messages that look like answers
  - `asked`: Count of assistant questions
  - `targetCountForRun`: 12 for new users, 6 for discovery mode

**Resume Notice Logic:**
- Shows "Welcome back" message when resuming after an assistant turn
- Only in diagnostic mode (not discovery)

---

### 3. Mode Determination (Lines 706-773)

The function switches between two modes based on `hasExistingReport`:

#### Diagnostic Mode (`isDiscoveryMode = false`)
- **Purpose:** Structured intake Q&A session
- **Behavior:**
  - Asks numbered questions (Q1, Q2, ..., Q12)
  - Tracks question numbers to avoid skipping
  - Validates answers using AI classifier
  - Prevents advancing if user hasn't answered
  - Uses `buildFreeformIntakePrompt()` helper

#### Discovery Mode (`isDiscoveryMode = true`)
- **Purpose:** Freeform conversational chat
- **Behavior:**
  - No numbered questions
  - Natural dialogue flow
  - References prior diagnostic report
  - Can answer questions about the report
  - Uses `buildDiscoveryChatPrompt()` helper

**System Prompts:**
- **Diagnostic:** Uses `EUPHORIAM_FREEFORM_INTAKE_SYSTEM_PROMPT` (includes support lock for questions)
- **Discovery:** Custom prompt emphasizing natural conversation, no Q&A structure

---

### 4. Kajabi Context Building (Lines 655-667)

```javascript
const { diagnosticContext, metrics } = await buildKajabiDiagnosticContext({
  email,
  assessmentIds,
});
```

**What `buildKajabiDiagnosticContext` does:**
1. Fetches customer by email from Kajabi API
2. Gets full customer details (sign-ins, revenue, etc.)
3. Resolves relationships:
   - Site information
   - Contact details
   - Products (with course data)
   - Offers
4. For each Course product:
   - Extracts course ID
   - Fetches course with posts
   - Extracts assessments from posts
   - Gets customer progress (completed/passed/failed)
5. Normalizes all data
6. Computes diagnostic metrics:
   - `engagementScore`: Based on sign-in count
   - `learningScore`: Based on assessment completion
   - `commitmentScore`: Based on revenue + products
   - `signalOutput`: Weighted combination
   - `signalCoherence`: Consistency metric
   - `gravity`: Inverse of signal output
   - `consciousnessLevel`: 1.0-5.0 scale
   - `qgcActivation`: Quantum Genius Code activation

**Membership Gate:**
- Checks if user is Creator Club member
- Returns 403 error if not a member

**User Creation:**
- Finds or creates app user record in database

---

### 5. RAG (Retrieval-Augmented Generation) (Lines 675-677)

```javascript
const retrieved = lastUser?.content
  ? await retrieveSimilarChunks({ query: lastUser.content, topK: 3 })
  : [];
```

**What happens:**
- Takes the last user message as query
- Searches vector database for similar content chunks
- Returns top 3 most relevant chunks
- These are included in the prompt for context-aware responses

---

### 6. Answer Validation (Lines 684-703)

```javascript
const aiAnswered = hasAssistantTurn && lastUser
  ? await isAiLikelyAnswer({
      question: lastAssistant.content,
      reply: lastUser.content,
    })
  : false;
```

**What `isAiLikelyAnswer` does:**
1. Basic heuristics:
   - Rejects if reply is a question
   - Rejects if contains clarification phrases ("elaborate", "clarify", etc.)
   - Requires at least 1 alphabetic character
2. AI classification:
   - Sends to GPT-4.1-mini with binary classifier prompt
   - Returns `true` if AI determines it's an answer

**Question Number Tracking:**
- Extracts "Q<number>" from assistant messages
- Tracks `maxQuestionNumber` to avoid skipping
- Determines if there's a `pendingQuestion` (asked but not answered)

---

### 7. Prompt Building (Lines 708-796)

#### For Discovery Mode:
```javascript
userPrompt = buildDiscoveryChatPrompt({
  transcript,
  retrieved,
  factsContext: diagnosticContext,
  userName: name,
  priorReport: priorReportSnippet,
});
```

#### For Diagnostic Mode:
```javascript
userPrompt = !hasAssistantTurn
  ? buildFreeformIntakePrompt({...})  // First question
  : aiAnswered
  ? buildFreeformIntakePrompt({...})  // Move to next question
  : `The user has NOT answered...`;   // Stay on same question
```

**Message Array Construction:**
1. System prompt (mode-specific)
2. Prior report snippet (if exists) as system message
3. Full transcript (user + assistant messages)
4. Final user prompt (instruction for next response)

---

### 8. OpenAI API Call (Lines 798-892)

**Token Limits:**
- Discovery mode:
  - Full report request: 800 tokens
  - Report question: 500 tokens
  - Normal: 300 tokens
- Diagnostic mode: 400 tokens

**Temperature Settings:**
- Discovery + full report: 0.3 (more focused)
- Discovery normal: 0.7 (more creative)
- Diagnostic: 0.3 (consistent)

**Model:** `gpt-5.2`

**Special Handling for Full Report Requests:**
- Detects phrases like "full report", "go deeper", "where can I improve"
- Updates system prompt to force comprehensive breakdown
- Implements retry logic (up to 1 retry) if response is empty
- Fallback mechanism with simpler prompt if retries fail

**Empty Response Handling:**
- For discovery mode: Provides helpful fallback message
- For diagnostic mode: Generic "How can I help?" message

---

### 9. Response Post-Processing (Lines 980-1041)

**Discovery Mode Cleanup:**
- Removes numbered question prefixes (Q1, Q2, etc.)
- Removes patterns like `**Q1 —**`, `Q1)`, etc.
- Ensures content remains after cleanup

**Diagnostic Mode:**
- Adds resume notice if applicable
- Strips filler before first Q-line when resuming
- Preserves resume notice if present

---

### 10. State Persistence (Lines 1043-1108)

**Updated Transcript:**
- Appends new assistant message to transcript

**Accepted Answers Tracking:**
- Maintains array of `{questionNumber, questionText, answerText}`
- Updates when user answers a question
- Supports resume functionality

**Intake State Object:**
```javascript
const intakeState = {
  transcript: updatedTranscript,
  acceptedAnswers,
  answeredCount,
  lastQuestionNumber: maxQuestionNumber,
  pendingQuestion,
  updatedAt: new Date().toISOString(),
};
```

**Database Update:**
- Updates existing diagnostic record OR creates new one
- Stores intake state in `data.intakeState`

---

### 11. Auto-Finalization (Lines 1110-1248)

**Trigger Conditions:**
- `!hasExistingReport` (first-time diagnostic)
- `answeredCount >= targetCount` (all questions answered)
- `!pendingQuestion` (no unanswered question)
- `aiAnswered` (last turn was a valid answer)

**What Happens:**
1. Rebuilds Kajabi context (fresh data)
2. Retrieves RAG chunks for final report
3. Gets latest prompt from database (`getLatestPromptFromDb`)
4. Calls OpenAI with `buildFinalReportPrompt()`:
   - Includes full customer context
   - All intake answers
   - Intro page text
   - RAG chunks
   - Previous report (if any)
5. Sanitizes report text
6. Creates/updates diagnostic record with:
   - Full customer profile
   - Metrics
   - Products/offers
   - Course assessments
   - AI report text
   - Intake transcript
7. Generates PDF using `generateDiagnosticPdf()`
8. Uploads PDF to Supabase storage
9. Sends email with PDF attachment
10. Persists discovery record
11. Returns success response with diagnostic data

**Note:** Auto-finalization only happens for first-time diagnostics, not discovery mode.

---

### 12. Manual Finalization (`finalize = true`) (Lines 1263-1478)

When `finalize=true`, the function skips the chat flow and generates a report immediately.

#### For Users with Existing Reports:
1. Generates a **discovery follow-up report** (not full diagnostic)
2. Uses GPT-4.1-mini (smaller model)
3. Creates brief summary (under 400 words):
   - Acknowledges prior diagnostic
   - Highlights changes
   - Answers follow-up questions
   - Recommends 3-5 next steps
4. Persists as Discovery record
5. Sends email with follow-up report
6. Returns discovery response

#### For First-Time Users:
1. Gets latest prompt from database
2. Builds Kajabi context
3. Calls OpenAI with `buildFinalReportPrompt()`
4. Generates full diagnostic report
5. Creates PDF and uploads to Supabase
6. Sends email with PDF
7. Persists discovery record
8. Returns diagnostic response

---

## Key Helper Functions

### `buildKajabiDiagnosticContext({ email, assessmentIds })`
- Fetches and normalizes all Kajabi customer data
- Computes diagnostic metrics
- Returns comprehensive context object

### `buildFreeformIntakePrompt({...})`
- Constructs prompt for diagnostic Q&A mode
- Includes transcript, facts context, RAG chunks
- Handles first question vs. subsequent questions
- Manages resume notices

### `buildDiscoveryChatPrompt({...})`
- Constructs prompt for discovery conversation mode
- Includes prior report for reference
- Emphasizes natural dialogue

### `buildFinalReportPrompt({...})`
- Constructs prompt for generating final diagnostic report
- Includes all intake answers, customer context, metrics
- Formats for PDF generation

### `getLatestPromptFromDb()`
- Fetches active prompt from database
- Appends support lock prompt (question handling rules)
- Returns full prompt with metadata

### `isAiLikelyAnswer({ question, reply })`
- Uses AI to classify if user reply is an answer
- Falls back to heuristics if AI fails

### `generateDiagnosticPdf(diagnostic)`
- Generates PDF file from diagnostic data
- Returns file path

### `uploadBufferToSupabase({ buffer, objectPath, contentType })`
- Uploads PDF buffer to Supabase storage
- Returns `{ path, url }` object

### `sendEmail(email, subject, html, pdfPath)`
- Sends email with PDF attachment
- Uses configured email service

### `persistDiscoveryRecord({...})`
- Saves discovery chat record to database
- Links to diagnostic and user
- Stores transcript snippets and PDF URL

---

## Database Models Used

### `Diagnostic`
- Stores diagnostic reports
- `data` field contains:
  - `intakeState`: Current intake progress
  - `aiReport`: Generated report text
  - `pdf`: PDF file info
  - `profile`: User profile
  - `metrics`: Computed metrics
  - `products`, `offers`, `courseAssessments`
  - `previousReports`: Array of historical reports

### `Discovery`
- Stores discovery chat records
- `data` field contains:
  - `transcript`: Conversation transcript
  - `previousReportSnippet`: Reference to prior diagnostic
  - `newReportSnippet`: Follow-up report
  - `pdfUrl`: Link to PDF (if any)

### `User`
- App user records
- Created/found via `findOrCreateCreatorUser()`

### `Prompt`
- Stores system prompts
- `isActive` flag determines which prompt to use
- `getLatestPromptFromDb()` fetches active prompt

---

## Error Handling

1. **Validation Errors:**
   - Missing email/name → 400 error
   - Not Creator Club member → 403 error

2. **AI API Errors:**
   - Empty responses → Fallback messages
   - Retry logic for full report requests
   - Graceful degradation

3. **Database Errors:**
   - Logged but don't crash the function
   - Discovery record persistence is non-blocking

4. **PDF/Email Errors:**
   - Logged but don't block response
   - Diagnostic still created even if PDF upload fails

---

## Response Formats

### Chat Response (Non-Finalize)
```json
{
  "success": true,
  "message": "Next chatbot message",
  "data": {
    "nextMessage": { "role": "assistant", "content": "..." },
    "transcript": [...],
    "intakeState": {...},
    "answeredCount": 5,
    "pendingQuestion": false,
    "aiAnswered": true,
    "resumeNotice": "Welcome back..."
  }
}
```

### Auto-Finalized Response
```json
{
  "success": true,
  "message": "Chatbot diagnostic (auto-finalized)",
  "data": {
    "diagnosticId": 123,
    "diagnostic": {...},
    "pdfPath": "/path/to/file.pdf",
    "pdfUrl": "https://...",
    "reportText": "...",
    "autoFinalized": true
  }
}
```

### Manual Finalize Response
```json
{
  "success": true,
  "message": "Chatbot diagnostic (freeform) generated",
  "data": {
    "diagnosticId": 123,
    "diagnostic": {...},
    "pdfPath": "/path/to/file.pdf",
    "pdfUrl": "https://...",
    "reportText": "..."
  }
}
```

### Discovery Follow-Up Response
```json
{
  "success": true,
  "message": "Discovery chat saved",
  "data": {
    "discovery": true,
    "message": "Discovery chat saved and emailed.",
    "discoveryReport": "..."
  }
}
```

---

## Important Notes

1. **Resume Functionality:**
   - Function supports resuming interrupted sessions
   - Uses stored `intakeState` to continue where left off
   - Tracks accepted answers per question number

2. **Question Number Management:**
   - Questions are numbered Q1, Q2, ..., Q12
   - Numbers only increment for NEW topics
   - Rephrasing/clarifying keeps same number
   - Prevents skipping numbers on resume

3. **Mode Locking:**
   - Once a diagnostic is completed, user enters discovery mode
   - Discovery mode cannot revert to diagnostic mode
   - New diagnostics require new email or manual reset

4. **PDF Generation:**
   - PDFs are generated server-side
   - Uploaded to Supabase for permanent storage
   - URLs stored in diagnostic record

5. **Email Notifications:**
   - Sent automatically on report generation
   - Includes PDF attachment
   - Uses configured email templates

6. **IP Protection:**
   - Euphoriam formula is never revealed
   - Signal Output calculation is proprietary
   - System prompts enforce IP protection

7. **Token Management:**
   - Different token limits for different scenarios
   - Full report requests get more tokens (800)
   - Discovery mode uses fewer tokens (300-500)

8. **RAG Integration:**
   - Retrieves similar content chunks for context
   - Only uses last user message as query
   - Top 3 chunks included in prompt

---

## Dependencies

- **OpenAI API:** GPT-5.2 and GPT-4.1-mini models
- **Sequelize:** Database ORM
- **Supabase:** File storage
- **Kajabi API:** Customer data integration
- **Email Service:** SMTP/email sending
- **PDF Generation Library:** Document creation

---

## Performance Considerations

1. **Kajabi API Calls:**
   - Multiple sequential API calls per request
   - Could be optimized with parallel requests
   - Caching could reduce load

2. **AI API Calls:**
   - Main bottleneck for response time
   - Retry logic adds latency
   - Token limits affect response quality

3. **PDF Generation:**
   - CPU-intensive operation
   - Done synchronously (could be async)
   - File I/O operations

4. **Database Queries:**
   - Multiple queries per request
   - Could benefit from eager loading
   - Transaction management for consistency

---

## Future Improvements

1. **Caching:**
   - Cache Kajabi context per email
   - Cache RAG results
   - Reduce API calls

2. **Async Processing:**
   - Move PDF generation to background job
   - Queue email sending
   - Improve response times

3. **Error Recovery:**
   - Better retry strategies
   - Partial state recovery
   - User-friendly error messages

4. **Monitoring:**
   - Track response times
   - Monitor AI API usage
   - Alert on failures

---

## Related Files

- `src/helpers/euphoriamChatbot.js` - Prompt building helpers
- `src/helpers/rag.js` - RAG retrieval logic
- `src/controllers/kajabi.js` - Kajabi API integration
- `src/utils/diagnosticPdf.js` - PDF generation
- `src/utils/email.js` - Email sending
- `src/utils/storage.js` - Supabase file upload
- `src/models/diagnosticModel.js` - Diagnostic database model
- `src/models/discoveryModel.js` - Discovery database model
- `src/models/promptModel.js` - Prompt database model

---

## Conclusion

The `chatbotDiagnosticFreeform` function is a complex, multi-modal system that handles:
- Structured diagnostic intake
- Freeform discovery conversations
- AI-powered report generation
- PDF creation and distribution
- State management and resume functionality
- Integration with Kajabi, Supabase, and email services

It serves as the central orchestrator for Euphoriam AI's diagnostic chatbot, managing the entire user journey from initial intake to final report delivery.






