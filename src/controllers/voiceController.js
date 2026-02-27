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
const { User } = require("../models/userModel");
const { UserLesson } = require("../models/userLesson");
const { message } = require("../schemas/userSchema");

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
  const { data: buckets, error: listError } =
    await supabase.storage.listBuckets();

  if (listError) {
    console.error("[voiceController] Error listing buckets:", listError);
    return false;
  }

  const bucketExists = buckets?.some((b) => b.name === bucketName);

  if (!bucketExists) {
    // Try to create the bucket
    const { data: newBucket, error: createError } =
      await supabase.storage.createBucket(bucketName, {
        public: true, // Make it publicly accessible
        fileSizeLimit: 52428800, // 50MB limit
        allowedMimeTypes: ["audio/*", "video/*", "application/octet-stream"],
      });

    if (createError) {
      console.error(
        `[voiceController] Failed to create bucket "${bucketName}":`,
        createError,
      );
      throw new Error(
        `Storage bucket "${bucketName}" does not exist and could not be created. ` +
          `Please create it in your Supabase dashboard: Storage > New bucket > Name: "${bucketName}" > Public: true`,
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
    if (
      error.statusCode === "404" ||
      error.message?.includes("Bucket not found")
    ) {
      throw new Error(
        `Storage bucket "${bucket}" not found. ` +
          `Please create it in your Supabase dashboard: Storage > New bucket > Name: "${bucket}" > Public: true`,
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
      500,
    );
  }
};

const createVoiceNote = async (req, res) => {
  try {
    const { email, text, course, module, lesson, completed } = req.body;
    const voiceFile = req.file;

    const findUser = await User.findOne({ where: { email } });
    if (!findUser) {
      return errorResponse(res, "user not found", 404);
    }

    const lessonWhere = {
      userId: String(findUser.id),
      ...(course && { course }),
      ...(module && { module }),
      ...(lesson && { lesson }),
    };

    const existingLesson = await UserLesson.findOne({
      where: lessonWhere,
      include: [{ model: VoiceNote }],
    });

    let content = (text || "").trim();
    let sourceType = "text";
    let transcriptMeta = null;
    let audioPath = null;
    let audioUrl = null;

    // =========================
    // HANDLE VOICE UPLOAD
    // =========================
    if (voiceFile) {
      const upload = await uploadVoiceToSupabase(voiceFile);
      const transcription = await transcribeAudio(voiceFile);

      if (!transcription?.text) {
        return errorResponse(
          res,
          "Unable to transcribe the provided voice file",
          502,
        );
      }
      // Check if transcription is likely a hallucination (silence detected)
      const duration = transcription.meta?.duration;
      const hasEmptyMetadata =
        !transcription.meta || Object.keys(transcription.meta).length === 0;

      // Empty metadata combined with common hallucination phrases is a strong indicator
      // Always check for hallucinations
      if (
        isLikelyHallucination(transcription.text, duration) ||
        (hasEmptyMetadata && isLikelyHallucination(transcription.text, null))
      ) {
        console.log("HAHAH");

        return errorResponse(
          res,
          "No speech detected in the audio. Please ensure your recording contains clear speech.",
          400,
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
        400,
      );
    }

    let voiceNote;

    // =========================
    // UPDATE EXISTING VOICE
    // =========================
    if (existingLesson && existingLesson.voiceId && existingLesson.VoiceNote) {
      voiceNote = existingLesson.VoiceNote;

      // Delete old audio file if replacing with new one
      if (voiceFile && voiceNote.audioPath) {
        const bucket = process.env.SUPABASE_STORAGE_BUCKET || "voice-notes";

        await supabase.storage
          .from(bucket)
          .remove([voiceNote.audioPath])
          .catch(() => {});
      }

      await voiceNote.update({
        content,
        sourceType,
        transcriptMeta,
        audioPath,
        audioUrl,
      });
    } else {
      // =========================
      // CREATE NEW VOICENOTE
      // =========================
      voiceNote = await VoiceNote.create({
        content,
        sourceType,
        transcriptMeta,
        audioPath,
        audioUrl,
      });
    }

    // =========================
    // UPSERT LESSON
    // =========================
    let saveLesson;

    if (existingLesson) {
      await existingLesson.update({
        isCompleted: completed,
        voiceId: voiceNote.id,
      });
      saveLesson = existingLesson;
    } else {
      saveLesson = await UserLesson.create({
        userId: String(findUser.id),
        course,
        module,
        lesson,
        isCompleted: completed,
        voiceId: voiceNote.id,
      });
    }

    return successResponse(res, "Voice/Text note saved", {
      saveLesson,
      content,
      audioUrl,
      updated: !!existingLesson,
    });
  } catch (error) {
    console.error("VoiceNote Upsert Error:", error);
    return errorResponse(res, error.message || "Server error", 500);
  }
};
const updateCompletion = async (req, res) => {
  try {
    const { email, course, module, lesson, completed } = req.body;
    console.log("body is", req.body);
    let saveLesson;
    const user = await User.findOne({ where: { email } });
    if (!user) return errorResponse(res, "User not found", 404);

    const lessonRecord = await UserLesson.findOne({
      where: {
        userId: String(user.id),
        course,
        module,
        lesson,
      },
    });

    if (!lessonRecord) {
      saveLesson = await UserLesson.create({
        userId: String(user.id),
        course,
        module,
        lesson,
        isCompleted: completed,
      });
      return successResponse(res, "Completion created", {
        saveLesson,
      });
    }

    await lessonRecord.update({
      isCompleted: completed,
    });

    return successResponse(res, "Completion updated", {
      completed,
    });
  } catch (error) {
    return errorResponse(res, error.message, 500);
  }
};

const getLessonRecording = async (req, res) => {
  try {
    const { email, course, module, lesson } = req.body;

    if (!email) {
      return res.status(400).json({
        status: false,
        message: "Email is required",
      });
    }

    // 1️⃣ Find user
    const findUser = await User.findOne({
      where: { email: String(email).trim() },
    });

    if (!findUser) {
      return res.status(404).json({
        status: false,
        message: "User not found",
      });
    }

    // 2️⃣ Build WHERE clause
    const whereClause = {
      userId: String(findUser.id),
      voiceId: { [Op.ne]: null },
    };

    // Use case-insensitive matching for safety
    if (course) {
      whereClause.course = { [Op.iLike]: String(course).trim() };
    }

    if (module) {
      whereClause.module = { [Op.iLike]: String(module).trim() };
    }

    if (lesson) {
      whereClause.lesson = { [Op.iLike]: String(lesson).trim() };
    }

    console.log("Search WHERE:", whereClause);

    // 3️⃣ Query
    const findLessonAdded = await UserLesson.findOne({
      where: whereClause,
      include: [
        {
          model: VoiceNote,
          attributes: ["id", "content", "sourceType", "audioUrl"],
        },
      ],
    });

    if (!findLessonAdded) {
      return res.status(404).json({
        status: false,
        message: "No recordings found",
      });
    }

    return res.status(200).json({
      status: true,
      message: "Recording fetched successfully",
      data: findLessonAdded,
    });
  } catch (error) {
    console.error("Database Error:", error);
    return res.status(500).json({
      status: false,
      message: "Internal server error",
      error: error.message,
    });
  }
};
const deleteLessonRecording = async (req, res) => {
  try {
    const { email, course, module, lesson } = req.body;

    if (!email) {
      return res.status(400).json({
        status: false,
        message: "Email is required",
      });
    }

    const findUser = await User.findOne({
      where: { email: String(email) },
    });

    if (!findUser) {
      return res.status(404).json({
        status: false,
        message: "User not found",
      });
    }

    const findLesson = await UserLesson.findOne({
      where: {
        userId: String(findUser.id),
        ...(course && { course: String(course) }),
        ...(module && { module: String(module) }),
        ...(lesson && { lesson: String(lesson) }),
        voiceId: { [Op.ne]: null },
      },
      include: [
        {
          model: VoiceNote,
        },
      ],
    });

    if (!findLesson || !findLesson.VoiceNote) {
      return res.status(404).json({
        status: false,
        message: "No recording found to delete",
      });
    }

    const voiceNote = findLesson.VoiceNote;

    if (voiceNote.audioPath) {
      const bucket = process.env.SUPABASE_STORAGE_BUCKET || "voice-notes";

      const { error: storageError } = await supabase.storage
        .from(bucket)
        .remove([voiceNote.audioPath]);

      if (storageError) {
        console.error("Storage delete error:", storageError);
      }
    }

    // 4️⃣ Delete VoiceNote record
    await VoiceNote.destroy({
      where: { id: voiceNote.id },
    });

    // 5️⃣ Remove voiceId from lesson
    await findLesson.update({
      voiceId: null,
    });

    return res.status(200).json({
      status: true,
      message: "Recording deleted successfully",
    });
  } catch (error) {
    console.error("Delete Recording Error:", error);
    return res.status(500).json({
      status: false,
      message: "Server error",
      error: error.message,
    });
  }
};

// Common Whisper hallucinations for silence/empty audio
const isLikelyHallucination = (text, duration) => {
  if (!text) return true;

  // Normalize text: lowercase, remove punctuation, trim
  const normalizedText = text
    .trim()
    .toLowerCase()
    .replace(/[.,!?;:]/g, "")
    .trim();

  // Common Whisper hallucinations (normalized, no punctuation)
  const hallucinationPhrases = [
    "thank you for watching",
    "thanks for watching",
    "thank you",
    "thanks",
    "you",
    "",
  ];

  // Check if transcript exactly matches common hallucinations
  if (hallucinationPhrases.includes(normalizedText)) {
    return true;
  }

  // Check if transcript starts with or contains common hallucination phrases
  const containsHallucination = hallucinationPhrases.some((phrase) => {
    if (!phrase) return false;
    return (
      normalizedText === phrase ||
      normalizedText.startsWith(phrase + " ") ||
      normalizedText === phrase
    );
  });

  if (containsHallucination && normalizedText.length < 30) {
    return true;
  }

  // Check if duration is very short (likely silence)
  if (duration && duration < 0.5) {
    return true;
  }

  // Check if transcript is suspiciously short (less than 3 words)
  const wordCount = normalizedText
    .split(/\s+/)
    .filter((w) => w.length > 0).length;
  if (wordCount <= 3 && containsHallucination) {
    return true;
  }

  // If metadata is empty/missing and text is very short, likely hallucination
  if (!duration && normalizedText.length < 20 && wordCount <= 4) {
    return true;
  }

  return false;
};

const transcribeRecording = async (req, res) => {
  try {
    const audioFile = req.file;

    if (!audioFile) {
      return errorResponse(
        res,
        "No audio file provided. Please upload a recording.",
        400,
      );
    }

    // Validate file type
    const allowedMimeTypes = [
      "audio/mpeg",
      "audio/mp3",
      "audio/wav",
      "audio/webm",
      "audio/ogg",
      "audio/m4a",
      "audio/x-m4a",
      "audio/mp4",
      "audio/x-wav",
      "audio/flac",
      "audio/aac",
    ];

    if (!allowedMimeTypes.includes(audioFile.mimetype)) {
      return errorResponse(
        res,
        `Unsupported file type: ${audioFile.mimetype}. Supported formats: MP3, WAV, WebM, OGG, M4A, FLAC, AAC`,
        400,
      );
    }

    // Transcribe the audio
    const transcription = await transcribeAudio(audioFile);

    if (!transcription?.text) {
      console.log("this is it");

      return errorResponse(
        res,
        "Unable to transcribe the audio file. Please ensure the file contains clear audio.",
        502,
      );
    }

    // Check if transcription is likely a hallucination (silence detected)
    const duration = transcription.meta?.duration;
    const hasEmptyMetadata =
      !transcription.meta || Object.keys(transcription.meta).length === 0;

    // Empty metadata combined with common hallucination phrases is a strong indicator
    // Always check for hallucinations
    if (
      isLikelyHallucination(transcription.text, duration) ||
      (hasEmptyMetadata && isLikelyHallucination(transcription.text, null))
    ) {
      console.log("HAHAH");

      return errorResponse(
        res,
        "No speech detected in the audio. Please ensure your recording contains clear speech.",
        400,
      );
    }

    // Return only the transcript (no storage)
    return successResponse(res, "Audio transcribed successfully", {
      transcript: transcription.text,
      metadata: {
        language: transcription.meta?.language,
        duration: transcription.meta?.duration,
      },
    });
  } catch (error) {
    console.log("error", error);

    return errorResponse(res, error, 500);
  }
};

module.exports = {
  createVoiceNote,
  attachVoiceNoteToUser,
  getAll,
  transcribeRecording,
  getLessonRecording,
  deleteLessonRecording,
  updateCompletion,
};
