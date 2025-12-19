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

const uploadVoiceToSupabase = async (file) => {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || "voice-notes";
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
    throw error;
  }

  const {
    data: { publicUrl },
  } = supabase.storage.from(bucket).getPublicUrl(objectPath);

  return { path: data?.path || objectPath, url: publicUrl };
};

const findDiagnosticByEmail = async (email) =>
  Diagnostic.findOne({
    where: {
      [Op.or]: [
        { email },
        sequelize.where(sequelize.json("data.profile.email"), email),
      ],
    },
    order: [["createdAt", "DESC"]],
  });

const createVoiceNote = async (req, res) => {
  const { email, text } = req.body;
  const voiceFile = req.file;

  if (!email) {
    return errorResponse(res, "Email is required to attach voice/text", 400);
  }

  const diagnostic = await findDiagnosticByEmail(email);
  if (!diagnostic) {
    return errorResponse(
      res,
      "No diagnostic found for the provided email",
      404
    );
  }

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
    diagnosticEmail: email,
    content,
    sourceType,
    transcriptMeta,
    audioPath,
    audioUrl,
  });

  return successResponse(res, "Voice/Text note saved", {
    id: voiceNote.id,
    diagnosticId: diagnostic.id,
    diagnosticEmail: voiceNote.diagnosticEmail,
    content: voiceNote.content,
    sourceType: voiceNote.sourceType,
    transcriptMeta: voiceNote.transcriptMeta,
    audioPath: voiceNote.audioPath,
    audioUrl: voiceNote.audioUrl,
  });
};

module.exports = { createVoiceNote };


