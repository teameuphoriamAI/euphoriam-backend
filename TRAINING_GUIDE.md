# Using Supabase Bucket PDFs for GPT Training

This guide explains how to use PDFs stored in your Supabase storage bucket to train GPT models using two approaches:

1. **RAG (Retrieval Augmented Generation)** - For real-time context retrieval
2. **Fine-tuning** - For training custom GPT models

## Prerequisites

- Supabase bucket with PDFs (default: `reports` bucket)
- Environment variables configured:
  - `SUPABASE_URL`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `SUPABASE_STORAGE_BUCKET_REPORTS` (optional, defaults to "reports")

## API Endpoints

### 1. Ingest PDFs for RAG (Retrieval Augmented Generation)

**Endpoint:** `POST /api/rag/ingest-bucket`

**Description:** Extracts text from PDFs in your Supabase bucket, chunks them, creates embeddings, and stores them in your database for RAG retrieval.

**Request Body:**
```json
{
  "bucket": "reports",           // Optional: bucket name (defaults to SUPABASE_STORAGE_BUCKET_REPORTS or "reports")
  "folder": "diagnostics/"       // Optional: folder path within bucket (e.g., "diagnostics/", "reports/2024/")
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/rag/ingest-bucket \
  -H "Content-Type: application/json" \
  -d '{
    "bucket": "reports",
    "folder": "diagnostics/"
  }'
```

**Response:**
```json
{
  "status": true,
  "message": "Bucket PDFs ingested for RAG",
  "result": {
    "count": 150,
    "ids": [1, 2, 3, ...],
    "files": ["diagnostic-1.pdf", "diagnostic-2.pdf", ...],
    "bucket": "reports",
    "folder": "diagnostics/"
  }
}
```

**What it does:**
- Lists all PDF files in the specified bucket/folder
- Downloads each PDF
- Extracts text using `pdf-parse`
- Chunks text into ~1200 character segments
- Creates embeddings using OpenAI's `text-embedding-3-small`
- Stores chunks in your database for semantic search

### 2. Extract PDFs for Fine-tuning

**Endpoint:** `POST /api/rag/extract-fine-tuning`

**Description:** Extracts text from PDFs and formats them as JSONL (JSON Lines) format ready for OpenAI fine-tuning.

**Request Body:**
```json
{
  "bucket": "reports",                    // Optional: bucket name
  "folder": "diagnostics/",               // Optional: folder path
  "systemPrompt": "You are a diagnostic report analyzer...",  // Optional: custom system prompt
  "saveFile": true                        // Optional: save JSONL file to disk
}
```

**Example Request:**
```bash
curl -X POST http://localhost:3000/api/rag/extract-fine-tuning \
  -H "Content-Type: application/json" \
  -d '{
    "bucket": "reports",
    "folder": "diagnostics/",
    "systemPrompt": "You are Euphoriam AI, a structural diagnostic intelligence.",
    "saveFile": true
  }'
```

**Response:**
```json
{
  "status": true,
  "message": "Fine-tuning data extracted",
  "result": {
    "examples": [...],
    "jsonl": "{\"messages\":[...]}\n{\"messages\":[...]}\n...",
    "count": 50,
    "files": ["diagnostic-1.pdf", "diagnostic-2.pdf", ...],
    "bucket": "reports",
    "folder": "diagnostics/",
    "filePath": "/path/to/training-data/fine-tuning-reports-1234567890.jsonl",
    "fileName": "fine-tuning-reports-1234567890.jsonl",
    "downloadUrl": "/training-data/fine-tuning-reports-1234567890.jsonl"
  }
}
```

**What it does:**
- Downloads and extracts text from all PDFs
- Formats each PDF as a training example in OpenAI's fine-tuning format
- Returns JSONL string ready for OpenAI fine-tuning API
- Optionally saves the JSONL file to `training-data/` directory

## Usage Examples

### Example 1: Ingest All PDFs from Reports Bucket for RAG

```javascript
// Using fetch
const response = await fetch('http://localhost:3000/api/rag/ingest-bucket', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    bucket: 'reports',
    folder: ''  // Root of bucket
  })
});

const result = await response.json();
console.log(`Ingested ${result.result.count} chunks from ${result.result.files.length} PDFs`);
```

### Example 2: Extract PDFs for Fine-tuning with Custom System Prompt

```javascript
const response = await fetch('http://localhost:3000/api/rag/extract-fine-tuning', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    bucket: 'reports',
    folder: 'diagnostics/',
    systemPrompt: 'You are Euphoriam AI, a structural diagnostic intelligence that analyzes consciousness patterns.',
    saveFile: true
  })
});

const result = await response.json();
// Download the JSONL file
const jsonlContent = result.result.jsonl;
// Or use the saved file path
const filePath = result.result.filePath;
```

### Example 3: Using the JSONL for OpenAI Fine-tuning

Once you have the JSONL file, you can upload it to OpenAI for fine-tuning:

```bash
# Upload file to OpenAI
curl https://api.openai.com/v1/files \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -F "file=@fine-tuning-reports-1234567890.jsonl" \
  -F "purpose=fine-tune"

# Create fine-tuning job
curl https://api.openai.com/v1/fine_tuning/jobs \
  -H "Authorization: Bearer $OPENAI_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{
    "training_file": "file-abc123",
    "model": "gpt-4o-mini"
  }'
```

## Custom Formatting for Fine-tuning

You can customize how PDFs are formatted by modifying the `formatFunction` in `src/helpers/supabaseRag.js`. The default format creates:

```json
{
  "messages": [
    {
      "role": "system",
      "content": "You are a helpful assistant..."
    },
    {
      "role": "user",
      "content": "Analyze this diagnostic report from diagnostic-1.pdf:"
    },
    {
      "role": "assistant",
      "content": "[Full PDF text content]"
    }
  ]
}
```

## Best Practices

1. **For RAG**: Use smaller chunks (1200 chars) for better semantic search
2. **For Fine-tuning**: Ensure PDFs are high-quality and representative of your use case
3. **Batch Processing**: Process PDFs in batches if you have many files
4. **Error Handling**: Check the response for failed files and retry if needed
5. **Storage**: Consider archiving processed PDFs to avoid reprocessing

## Troubleshooting

### PDFs not found
- Check bucket name and folder path
- Ensure PDFs are in the correct bucket
- Verify Supabase storage permissions

### Empty text extraction
- Some PDFs may be image-based (scanned documents)
- Consider using OCR for image-based PDFs
- Check PDF file integrity

### Rate limiting
- OpenAI API has rate limits for embeddings
- Process PDFs in smaller batches
- Add delays between requests if needed

## Environment Variables

Make sure these are set in your `.env` file:

```env
SUPABASE_URL=your_supabase_url
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
SUPABASE_STORAGE_BUCKET_REPORTS=reports  # Optional, defaults to "reports"
OPENAI_API_KEY=your_openai_api_key  # Required for embeddings
```

## Next Steps

1. **Test RAG**: After ingesting, test retrieval with `/api/rag/search`
2. **Fine-tune Model**: Upload JSONL to OpenAI and create fine-tuning job
3. **Monitor**: Track fine-tuning job progress via OpenAI dashboard
4. **Deploy**: Use fine-tuned model in your application

