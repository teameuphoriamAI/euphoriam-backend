const JsBarcode = require("jsbarcode");
const { supabase } = require("../config/supabase");
const { successResponse, errorResponse } = require("../utils/response");
const path = require("path");
const { Barcode } = require("../models/barcodeModel");

const { createCanvas, loadImage } = require("canvas");
const QRCode = require("qrcode"); // New dependency
// Helper: Ensure bucket exists (Your existing function)
const ensureBucketExists = async (bucketName) => {
  const { data: buckets, error: listError } =
    await supabase.storage.listBuckets();
  if (listError) return false;

  const bucketExists = buckets?.some((b) => b.name === bucketName);
  if (!bucketExists) {
    await supabase.storage.createBucket(bucketName, {
      public: true,
      allowedMimeTypes: ["image/png"], // Updated for images
    });
  }
  return true;
};

// Modified: Handles direct Buffer upload
const uploadBarcodeToSupabase = async (buffer) => {
  const bucket = process.env.SUPABASE_STORAGE_BARCODE || "barcodes";
  await ensureBucketExists(bucket);

  // Generate unique filename
  const fileName = `barcode-${Date.now()}-${Math.random().toString(16).slice(2)}.png`;
  const objectPath = `products/${fileName}`;

  const { data, error } = await supabase.storage
    .from(bucket)
    .upload(objectPath, buffer, {
      contentType: "image/png",
      upsert: false,
    });

  if (error) throw error;

  // Get public URL
  const {
    data: { publicUrl },
  } = supabase.storage.from(bucket).getPublicUrl(objectPath);

  return { path: data?.path || objectPath, url: publicUrl };
};

const createBarcodeForProduct = async (req, res) => {
  try {
    const { websiteLink, productName } = req.body; // logoUrl can be a local path or remote URL
    if (!websiteLink) {
      return errorResponse(res, "website link is required");
    }
    const findBarcode = await Barcode.findOne({
      where: {
        websiteLink,
        productName,
      },
    });
    if (findBarcode) {
      return errorResponse(res, "Barcode already created", 403);
    }
    let logoUrl = process.env.LOGO_URL;
    const canvasSize = 400;
    const canvas = createCanvas(canvasSize, canvasSize);
    const ctx = canvas.getContext("2d");

    // 1. Generate the base QR Code on the canvas
    // Use errorCorrectionLevel: 'H' to allow for the logo overlay
    await QRCode.toCanvas(canvas, websiteLink, {
      errorCorrectionLevel: "H",
      margin: 1,
      width: canvasSize,
      color: {
        dark: "#000000",
        light: "#ffffff",
      },
    });

    // 2. Overlay the Logo in the center
    if (logoUrl) {
      const logo = await loadImage(logoUrl);
      const logoSize = canvasSize * 0.2; // Logo should not exceed 30% of area
      const x = (canvasSize - logoSize) / 2;
      const y = (canvasSize - logoSize) / 2;

      // Optional: Draw a white background behind the logo for better scannability
      ctx.fillStyle = "#ffffff";
      ctx.fillRect(x - 5, y - 5, logoSize + 10, logoSize + 10);

      ctx.drawImage(logo, x, y, logoSize, logoSize);
    }

    // 3. Get Buffer and Upload to Supabase
    const buffer = canvas.toBuffer("image/png");
    const uploadResult = await uploadBarcodeToSupabase(buffer);
    let payload = {
      websiteLink,
      productName,
      barcodeImage: uploadResult.url,
    };
    const saveBarcode = await Barcode.create(payload);

    return successResponse(
      res,
      "QR Code generated and uploaded successfully",
      saveBarcode,
    );
  } catch (error) {
    console.error("QR Generation Error:", error);
    return errorResponse(res, "Failed to generate or upload QR code");
  }
};
const getAllBarcode = async (req, res) => {
  try {
    const getAllBarcode = await Barcode.findAll();
    if (getAllBarcode.length <= 0) {
      return errorResponse(res, "No barcode found", 404);
    }
    return successResponse(res, "barcode fetched duccessfully", getAllBarcode);
  } catch (error) {
    console.error("QR Generation Error:", error);
    return errorResponse(res, "Failed to get QR code");
  }
};
const deleteBarcode = async (req, res) => {
  try {
    const { id } = req.params;
    console.log(req.params, req.query);

    const getBarcode = await Barcode.findOne({ where: { id } });
    if (!getBarcode) {
      return errorResponse(res, "No barcode found", 404);
    }
    await Barcode.destroy({
      where: { id },
    });
    return successResponse(res, "barcode deleted duccessfully");
  } catch (error) {
    console.error("QR Generation Error:", error);
    return errorResponse(res, "Failed to get QR code");
  }
};
module.exports = { createBarcodeForProduct, getAllBarcode, deleteBarcode };
