const { supabase } = require("../config/supabase");

/**
 * Upload a buffer to Supabase storage.
 * @param {Object} params
 * @param {Buffer} params.buffer - File buffer to upload.
 * @param {string} params.objectPath - Path within the bucket (e.g., "diagnostics/123.pdf").
 * @param {string} [params.bucket] - Bucket name; defaults to SUPABASE_STORAGE_BUCKET_REPORTS or "reports".
 * @param {string} [params.contentType] - MIME type; defaults to application/octet-stream.
 * @returns {Promise<{ path: string, url: string }>}
 */
const uploadBufferToSupabase = async ({
  buffer,
  objectPath,
  bucket = process.env.SUPABASE_STORAGE_BUCKET_REPORTS || "reports",
  contentType = "application/octet-stream",
}) => {
  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(objectPath, buffer, {
      contentType,
      upsert: true,
    });

  if (error) {
    throw error;
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(bucket).getPublicUrl(objectPath);

  return { path: data?.path || objectPath, url: publicUrl };
};

module.exports = { uploadBufferToSupabase };








