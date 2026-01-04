const fs = require("fs");
const os = require("os");
const path = require("path");
const { Op } = require("sequelize");
const openai = require("../config/openai");
const { supabase } = require("../config/supabase");
const { sequelize } = require("../config/sequelize");
const { VoiceNote } = require("../models/voiceNoteModel");
const { Diagnostic } = require("../models/diagnosticModel");
const { successResponse, errorResponse } = require("../utils/response");
const { User } = require("../models");

const ensureTempFile = async (file) => {
  const safeName = file.originalname.replace(/\s+/g, "_");
  const tempPath = path.join(os.tmpdir(), `voice-${Date.now()}-${safeName}`);
  await fs.promises.writeFile(tempPath, file.buffer);
  return tempPath;
};

const transcribeAudio = async (file) => {
  const tempPath = await ensureTempFile(file);

  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      response_format: "json",
    });

    return {
      text: response?.text?.trim(),
      meta: {
        model: response?.model || "whisper-1",
        duration: response?.duration,
        language: response?.language,
        originalFileName: file.originalname,
        mimeType: file.mimetype,
      },
    };
  } finally {
    fs.promises.unlink(tempPath).catch(() => {});
  }
};

// Helper function to ensure bucket exists
const ensureBucketExists = async (bucketName) => {
  // Check if bucket exists by trying to list it
  const { data: buckets, error: listError } = await supabase.storage.listBuckets();
  
  if (listError) {
    console.error("[voiceController] Error listing buckets:", listError);
    return false;
  }

  const bucketExists = buckets?.some((b) => b.name === bucketName);
  
  if (!bucketExists) {
    // Try to create the bucket
    const { data: newBucket, error: createError } = await supabase.storage.createBucket(bucketName, {
      public: true, // Make it publicly accessible
      fileSizeLimit: 52428800, // 50MB limit
      allowedMimeTypes: ['audio/*', 'video/*', 'application/octet-stream'],
    });

    if (createError) {
      console.error(`[voiceController] Failed to create bucket "${bucketName}":`, createError);
      throw new Error(
        `Storage bucket "${bucketName}" does not exist and could not be created. ` +
        `Please create it in your Supabase dashboard: Storage > New bucket > Name: "${bucketName}" > Public: true`
      );
    }
    
    console.log(`[voiceController] Created bucket "${bucketName}"`);
    return true;
  }
  
  return true;
};

const uploadVoiceToSupabase = async (file) => {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "voice-notes";
  
  // Ensure bucket exists before uploading
  await ensureBucketExists(bucket);
  
  const ext = path.extname(file.originalname) || ".bin";
  const objectPath = `voices/${Date.now()}-${Math.random()
    .toString(16)
    .slice(2)}${ext}`;

  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(objectPath, file.buffer, {
      contentType: file.mimetype || "application/octet-stream",
      upsert: false,
    });

  if (error) {
    // Provide more helpful error messages
    if (error.statusCode === "404" || error.message?.includes("Bucket not found")) {
      throw new Error(
        `Storage bucket "${bucket}" not found. ` +
        `Please create it in your Supabase dashboard: Storage > New bucket > Name: "${bucket}" > Public: true`
      );
    }
    throw error;
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(bucket).getPublicUrl(objectPath);

  return { path: data?.path || objectPath, url: publicUrl };
};

const findUserByEmail = async (email) =>
  User.findOne({
    where: { email },
    order: [["createdAt", "DESC"]],
  });

const transcribeVoiceFile = async (file) => {
  if (!file) throw new Error("No file provided for transcription");
  console.log("fole", file);

  // Save buffer to temp file
  const safeName = file.originalname.replace(/\s+/g, "_");
  const tempPath = path.join(os.tmpdir(), `voice-${Date.now()}-${safeName}`);
  await fs.promises.writeFile(tempPath, file.buffer);

  try {
    const response = await openai.audio.transcriptions.create({
      file: fs.createReadStream(tempPath),
      model: "whisper-1",
      response_format: "json",
    });

    if (!response?.text) return null;

    return {
      text: response.text.trim(),
      meta: {
        model: response.model || "whisper-1",
        duration: response.duration,
        language: response.language,
        originalFileName: file.originalname,
        mimeType: file.mimetype,
      },
    };
  } finally {
    fs.promises.unlink(tempPath).catch(() => {});
  }
};
const attachVoiceNoteToUser = async (req, res) => {
  try {
    //voiceId to attach to user
    const { email, voiceId } = req.body;
    if (!email) throw new Error("Email is required to attach a note");
    if (!voiceId) throw new Error("voiceId is required");

    // 1️⃣ Find user by email
    const user = await findUserByEmail(email);
    if (!user) {
      throw new Error(`No user found for email: ${email}`);
    }

    // 2️⃣ Find the existing voice note
    const voiceNote = await VoiceNote.findOne({ where: { id: voiceId } });
    if (!voiceNote) {
      throw new Error("Voice note not found");
    }

    // 3️⃣ Update the userId
    await voiceNote.update({ userId: user.id });

    // 4️⃣ Return updated info
    return successResponse(res, "transcript attached to user", voiceNote);
  } catch (error) {
    return errorResponse(res, error);
  }
};
const getAll = async (req, res) => {
  try {
    const voiceNotes = await VoiceNote.findAll({
      order: [["createdAt", "DESC"]],
      include: [
        {
          model: User,
          as: "user", // must match the alias above
          attributes: ["id", "email", "name", "createdAt"], // choose fields you need
        },
      ],
    });

    return successResponse(res, "All voice notes retrieved", voiceNotes);
  } catch (error) {
    return errorResponse(
      res,
      error.message || "Failed to fetch voice notes",
      500
    );
  }
};

const createVoiceNote = async (req, res) => {
  const { email, text } = req.body;
  const voiceFile = req.file;
  console.log("voice", voiceFile);

  // if (!email) {
  //   return errorResponse(res, "Email is required to attach voice/text", 400);
  // }

  // const diagnostic = await findDiagnosticByEmail(email);
  // if (!diagnostic) {
  //   return errorResponse(
  //     res,
  //     "No diagnostic found for the provided email",
  //     404
  //   );
  // }

  let content = (text || "").trim();
  let sourceType = "text";
  let transcriptMeta = null;
  let audioPath = null;
  let audioUrl = null;

  if (voiceFile) {
    const upload = await uploadVoiceToSupabase(voiceFile);
    const transcription = await transcribeAudio(voiceFile);

    if (!transcription?.text) {
      return errorResponse(
        res,
        "Unable to transcribe the provided voice file",
        502
      );
    }

    content = transcription.text;
    sourceType = "voice";
    transcriptMeta = transcription.meta;
    audioPath = upload.path;
    audioUrl = upload.url;
  }

  if (!content) {
    return errorResponse(
      res,
      "Provide either text content or a voice recording",
      400
    );
  }

  const voiceNote = await VoiceNote.create({
    // diagnosticEmail: email,
    content,
    sourceType,
    transcriptMeta,
    audioPath,
    audioUrl,
  });

  return successResponse(res, "Voice/Text note saved", voiceNote);
};

module.exports = { createVoiceNote, attachVoiceNoteToUser, getAll };
