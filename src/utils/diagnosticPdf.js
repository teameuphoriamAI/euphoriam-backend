const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");
require("dotenv").config();
const axios = require("axios");
const { generateIrlReportPdf } = require("./irlPdf");
const {
  normalizeClLevel,
  normalizeClDisplay,
  normalizeDiagnosticMetrics,
  consciousnessLevelToDisplayPct,
  formatConsciousnessLevel,
} = require("../helpers/stage1StructuralMap");

const logoImage = process.env.LOGO_URL;

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const addSection = (doc, title, bodyLines) => {
  if (!bodyLines || bodyLines.length === 0) return;
  const sectionWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.moveDown(0.6);
  doc.fontSize(13).text(title, {
    underline: true,
    width: sectionWidth,
    lineGap: 2,
  });
  doc.moveDown(0.2);
  bodyLines.forEach((line) =>
    doc.fontSize(11).text(line, {
      width: sectionWidth,
      lineGap: 2,
    }),
  );
};

const addList = (doc, title, items) => {
  if (!items || items.length === 0) return;
  const listWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.moveDown(0.6);
  doc.fontSize(13).text(title, {
    underline: true,
    width: listWidth,
    lineGap: 2,
  });
  doc.moveDown(0.2);
  items.forEach((item) =>
    doc.fontSize(11).text(`• ${item}`, {
      width: listWidth,
      lineGap: 2,
    }),
  );
};

// Helper to draw the segmented gauge (10 blocks) - matches image exactly
const renderVisualGauge = (doc, metrics) => {
  if (!metrics) return;

  const gaugeMetrics = [
    { label: "QGC Activation", val: metrics.qgcActivation },
    {
      label: "Consciousness Level",
      val: metrics.consciousnessLevel,
    },
    { label: "Gravity (Load)", val: metrics.gravity },
    { label: "Signal Coherence", val: metrics.signalCoherence },
    { label: "Signal Output", val: metrics.signalOutput },
  ];

  // Title - bold, left-aligned, matching image
  doc.moveDown(1);
  doc
    .font("Helvetica-Bold")
    .fontSize(16)
    .fillColor("#000000")
    .text("METRICS GAUGE (Current Snapshot)", {
      align: "left",
      width: doc.page.width - doc.page.margins.left - doc.page.margins.right,
    });
  doc.moveDown(1);

  const startY = doc.y;
  let currentY = startY;

  gaugeMetrics.forEach((m) => {
    if (m.val === undefined || m.val === null) return;

    // Calculate value and percentage
    let pct = 0;
    let displayVal = "";

    if (m.label.includes("Consciousness")) {
      pct = consciousnessLevelToDisplayPct(m.val) ?? 0;
      pct = Math.max(0, Math.min(100, pct));
      displayVal = formatConsciousnessLevel(m.val) ?? String(m.val);
    } else {
      const val = parseFloat(m.val);
      pct = Math.max(0, Math.min(100, val));
      displayVal = `${Math.round(val)}%`;
    }

    // Draw label - regular font, matching image style
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor("#000000")
      .text(m.label + ":", doc.page.margins.left, currentY + 1, { width: 180 });

    // Draw visual blocks (10 blocks total, matching image)
    const blockCount = 10;
    const blockWidth = 14; // Slightly wider blocks for better visibility
    const blockHeight = 14; // Square-ish blocks
    const blockSpacing = 3; // Space between blocks
    const blocksStartX = doc.page.margins.left + 190;
    const blocksY = currentY;

    // Calculate filled blocks based on percentage
    const filledBlocks = Math.max(
      0,
      Math.min(blockCount, Math.round((pct / 100) * blockCount)),
    );

    // Draw each block
    for (let i = 0; i < blockCount; i++) {
      const blockX = blocksStartX + i * (blockWidth + blockSpacing);
      const isFilled = i < filledBlocks;

      // Draw block rectangle
      if (isFilled) {
        // Filled block: black fill with black border
        doc
          .rect(blockX, blocksY, blockWidth, blockHeight)
          .lineWidth(0.5)
          .fillColor("#000000")
          .fill()
          .strokeColor("#000000")
          .stroke();
      } else {
        // Empty block: white fill with black border
        doc
          .rect(blockX, blocksY, blockWidth, blockHeight)
          .lineWidth(0.5)
          .fillColor("#FFFFFF")
          .fill()
          .strokeColor("#000000")
          .stroke();
      }
    }

    // Draw value text on the right
    const totalBlocksWidth =
      blockCount * blockWidth + (blockCount - 1) * blockSpacing;
    const valueX = blocksStartX + totalBlocksWidth + 15;
    doc
      .font("Helvetica")
      .fontSize(11)
      .fillColor("#000000")
      .text(displayVal, valueX, currentY + 2);

    // Move to next row
    currentY += 20; // Spacing between metric rows
  });

  doc.y = currentY;
  doc.moveDown(1);
};

// Helper to draw a visual gauge bar using rectangles (12 blocks - matches old code)
const drawGaugeBar = (doc, startX, startY, value, totalBlocks = 12) => {
  const v = Math.max(0, Math.min(100, Number(value || 0)));
  const filled = Math.round((v / 100) * totalBlocks);
  const blockWidth = 8; // Width of each block in points
  const blockHeight = 10; // Height of each block in points
  const blockGap = 1; // Gap between blocks

  // Save current fill color
  const savedFillColor = doc._fillColor;

  let currentX = startX;

  // Draw filled blocks (black)
  for (let i = 0; i < filled; i++) {
    doc
      .rect(currentX, startY, blockWidth, blockHeight)
      .fillColor("#000000")
      .fill();
    currentX += blockWidth + blockGap;
  }

  // Draw empty blocks (white with gray border)
  for (let i = filled; i < totalBlocks; i++) {
    doc
      .rect(currentX, startY, blockWidth, blockHeight)
      .strokeColor("#CCCCCC")
      .lineWidth(0.8)
      .stroke();

    currentX += blockWidth + blockGap;
  }

  // Restore fill color for text
  doc.fillColor(savedFillColor || "#111111");

  return currentX; // Return the end X position
};

// Helper to render a single line metric with proper spacing (matches old code)
const renderMetricLine = (doc, label, value, isPercentage = true) => {
  // Check if value is actually defined (not undefined, null, or NaN)
  const hasValue = value !== undefined && value !== null && !isNaN(value);

  // Set font for label
  doc.font("Helvetica").fontSize(11);

  // Calculate positions - everything on the same line
  const labelStartX = doc.page.margins.left;
  const currentY = doc.y;
  const labelWidth = 160; // Fixed width for label column
  const gaugeStartX = labelStartX + labelWidth; // Start gauge right after label
  const blockHeight = 10; // Height of gauge blocks
  // Align gauge bar vertically with text baseline
  const textBaselineOffset = 8; // Approximate offset for text baseline
  const gaugeStartY = currentY + textBaselineOffset - blockHeight / 2;
  const totalBlockWidth = 12 * 8 + 11 * 1; // 12 blocks * 8pt + 11 gaps * 1pt = 107pt
  const valueStartX = gaugeStartX + totalBlockWidth + 8; // 8pt gap after gauge

  // Draw label on the same line - use absolute positioning to prevent wrapping
  const labelText = label.replace(/:/g, ":"); // Ensure colon is included
  doc.text(labelText, labelStartX, currentY, {
    width: labelWidth,
    lineGap: 0,
  });

  if (!hasValue) {
    // Draw empty gauge
    drawGaugeBar(doc, gaugeStartX, gaugeStartY, 0);
    doc.text("Unknown", valueStartX, currentY, {
      width: 80,
      lineGap: 0,
    });
    // Minimal spacing between metrics
    doc.moveDown(0.2);
    return;
  }

  let displayValue = Number(value);
  if (!isPercentage) {
    const percentageForGauge = Math.max(
      0,
      Math.min(100, consciousnessLevelToDisplayPct(displayValue) ?? 0),
    );
    const valueText = formatConsciousnessLevel(displayValue) ?? "Unknown";
    drawGaugeBar(doc, gaugeStartX, gaugeStartY, percentageForGauge);
    doc.font("Helvetica").fontSize(11).fillColor("#111111");
    doc.text(valueText, valueStartX, currentY, {
      width: 80,
      align: "left",
      lineGap: 0,
    });
    doc.moveDown(0.2);
    return;
  }
  // For gauge visualization: convert to percentage
  const percentageForGauge = displayValue;
  const valueText = `${Math.round(displayValue)}%`;

  drawGaugeBar(doc, gaugeStartX, gaugeStartY, percentageForGauge);
  doc.font("Helvetica").fontSize(11).fillColor("#111111");
  doc.text(valueText, valueStartX, currentY, {
    width: 80,
    align: "left",
    lineGap: 0,
  });
  doc.moveDown(0.2);
};

const renderGauge = (value) => {
  // Deprecated but kept for compatibility if needed elsewhere
  const v = Math.max(0, Math.min(100, Number(value || 0)));
  return `${v}%`;
};

const drawDivider = (doc) => {
  const left = doc.page.margins.left;
  const right = doc.page.width - doc.page.margins.right;
  const y = doc.y + 6;
  doc
    .moveTo(left, y)
    .lineTo(right, y)
    .lineWidth(1)
    .strokeColor("#111111")
    .stroke();
  doc.moveDown(1);
};
const drawMetricsTable = (doc, metrics) => {
  const startX = doc.page.margins.left;
  let y = doc.y;
  const rowHeight = 20;
  const colWidths = [150, 150]; // Adjust as needed

  const clDisplay = formatConsciousnessLevel(metrics.consciousnessLevel);
  const tableData = [
    ["Metric", "Value"],
    ["QGC Activation", `${metrics.qgcActivation ?? "N/A"}%`],
    [
      "Consciousness Level",
      clDisplay != null ? `${clDisplay} / 5.0` : "N/A",
    ],
    ["Gravity", `${metrics.gravity ?? "N/A"}%`],
    ["Signal Coherence", `${metrics.signalCoherence ?? "N/A"}%`],
    ["Signal Output", `${metrics.signalOutput ?? "N/A"}%`],
  ];

  tableData.forEach((row, i) => {
    let x = startX;
    row.forEach((cell, j) => {
      doc.rect(x, y, colWidths[j], rowHeight).stroke(); // Draw border
      doc.text(cell, x + 5, y + 5, { width: colWidths[j] - 10, align: "left" });
      x += colWidths[j];
    });
    y += rowHeight;
  });

  doc.moveDown(2);
};

const drawMetricsInterpretationTable = (doc) => {
  // Hardcoded fallback table (if no specific table provided in text)
  const availableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;
  const colWidths = [
    availableWidth * 0.18,
    availableWidth * 0.22,
    availableWidth * 0.2,
    availableWidth * 0.2,
    availableWidth * 0.2,
  ];

  const tableData = [
    [
      "Metric",
      "What It Represents",
      "Low (0-39)",
      "Mid (40-69)",
      "High (70-100)",
    ],
    [
      "QGC Activation",
      "Access to your native creation codes",
      "Codes dormant; expression feels blocked",
      "Codes intermittent; talent present, inconsistent",
      "Codes online; expression is potent and clear",
    ],
    [
      "Consciousness Level",
      "Vantage point of perception and authorship",
      "Reactive/survival-led perception",
      "Mixed perception; oscillates under stress",
      "Author-level perception; stable self-leadership",
    ],
    [
      "Gravity",
      "Pull of old identity and inherited roles",
      "Low pull; change is easier to sustain",
      "Moderate pull; requires structure to stabilize",
      "Strong pull; loyalty patterns dominate unless addressed",
    ],
    [
      "Signal Coherence",
      "Alignment between truth, emotion, choice, action",
      "Fragmented signal; mixed outcomes",
      "Partial alignment; results come with effort",
      "Clean alignment; reality responds quickly",
    ],
    [
      "Signal Output",
      "Broadcast strength to reality (IP-protected)",
      "Low broadcast; muted impact/traction",
      "Moderate broadcast; traction with consistency",
      "High broadcast; strong impact, visibility, manifestation",
    ],
  ];

  renderTableData(doc, tableData, colWidths);
};

const renderTableData = (doc, tableData, colWidths) => {
  const startX = doc.page.margins.left;
  let y = doc.y;
  const padding = 5;
  const headerRowHeight = 25;

  // Draw header row
  doc.font("Helvetica-Bold").fontSize(9);
  let x = startX;
  tableData[0].forEach((cell, j) => {
    doc.rect(x, y, colWidths[j], headerRowHeight).stroke();
    doc.text(cell, x + padding, y + padding, {
      width: colWidths[j] - 2 * padding,
      align: "left",
      lineGap: 1,
    });
    x += colWidths[j];
  });
  y += headerRowHeight;

  // Draw data rows
  doc.font("Helvetica").fontSize(8);
  for (let i = 1; i < tableData.length; i++) {
    const row = tableData[i];

    // Check if we need a new page
    if (y > doc.page.height - doc.page.margins.bottom - 50) {
      // -50 for some buffer
      doc.addPage();
      y = doc.page.margins.top;
    }

    x = startX;

    // Calculate row height
    let maxHeight = 30; // Minimum row height
    row.forEach((cell, j) => {
      const height =
        doc.heightOfString(cell, { width: colWidths[j] - 2 * padding }) +
        2 * padding;
      if (height > maxHeight) maxHeight = height;
    });

    row.forEach((cell, j) => {
      doc.rect(x, y, colWidths[j], maxHeight).stroke();
      doc.text(cell, x + padding, y + padding, {
        width: colWidths[j] - 2 * padding,
        align: "left",
        lineGap: 1,
      });
      x += colWidths[j];
    });
    y += maxHeight;
  }

  doc.moveDown(2);
  doc.x = doc.page.margins.left;
  doc.font("Helvetica").fontSize(11);
};

const isAllCapsHeader = (line) => {
  if (!line) return false;
  const cleanLine = line.replace(/^[\u2000-\u2BFF\s]+/, "").trim(); // Remove leading emojis/symbols
  if (cleanLine.length < 6) return false;
  // Allow letters, numbers, and common punctuation/symbols including TM and dashes
  return (
    /^[A-Z0-9]/.test(cleanLine) &&
    cleanLine === cleanLine.toUpperCase() &&
    !/^[0-9.]+$/.test(cleanLine)
  ); // Don't match just numbers (like 1.4)
};

/**
 * Cleans text by removing problematic special characters while preserving important formatting
 */
/**
 * Cleans text by removing problematic special characters while preserving important formatting
 */
const cleanText = (text) => {
  if (!text) return text;
  let cleaned = String(text);

  // Remove known decoration emojis/chars
  cleaned = cleaned
    .replace(/✨/g, "")
    .replace(/⚠️/g, "")
    .replace(/●/g, "•")
    .replace(/•/g, "•")
    .replace(/─/g, "")
    .replace(/→/g, "->")
    .replace(/↓/g, "");

  // Remove ** (asterisks) entirely if used purely as formatting noise in this context,
  // OR handle them. The user says "alot of steric", likely meaning "**" in "Client: ** Yashal".
  // We can strip all "**" globally here since we handle bolding differently now or if the text is plain.
  // Ideally we only strip them if they are noise. But given the request "remove that", let's strip them
  // unless captured by specific bold logic which we might skip if we just want clean text.
  // Actually, 'renderTextWithBold' relies on them.
  // But the user complained about "Client: ** Yashal".
  // We should fix the Metadata rendering to specifically strip them there,
  // AND in general body text, cleaner to just strip them if they are causing issues or ensure renderTextWithBold handles them nicely.
  // Let's improve the metadata regex instead.

  // NOTE: We used to remove all asterisks here, but that broke renderTextWithBold.
  // We only remove them here if they are standalone noise.
  // Bold markers (**) are preserved for renderTextWithBold to process.

  // Remove common encoding artifacts
  cleaned = cleaned
    .replace(/[^\x20-\x7E\n\r\t•\*]/g, "") // Preserve asterisks
    .replace(/&nbsp;/g, " ")
    .replace(/1:1/g, " 1:1 session")
    .replace(/\s+/g, " ");

  return cleaned.trim();
};

/**
 * Renders text with inline markdown bold formatting (**text**)
 * Uses a simpler approach: process line and render with proper fonts
 */
const renderTextWithBold = (doc, text, options = {}) => {
  const { width, lineGap = 2, indent = 0, oblique = false } = options;
  const fontSize = doc._fontSize || 11;
  const normalFont = oblique ? "Helvetica-Oblique" : "Helvetica";
  const boldFont = oblique ? "Helvetica-BoldOblique" : "Helvetica-Bold";

  // Clean text first
  let cleanTextValue = cleanText(text);

  // Check if text contains bold markers
  // We check for the pattern **text**
  if (!cleanTextValue.match(/\*\*([^*]+)\*\*/)) {
    // No bold formatting, render normally (but strip any single asterisks if they are noise)
    doc
      .font(normalFont)
      .text(cleanTextValue.replace(/\*\*/g, "").replace(/\*/g, ""), {
        width,
        lineGap,
        indent,
      });
    return;
  }

  // Parse text to extract bold and normal segments
  const segments = [];
  let lastIndex = 0;
  const boldRegex = /\*\*([^*]+)\*\*/g;
  let match;

  while ((match = boldRegex.exec(cleanTextValue)) !== null) {
    // Add normal text before bold
    if (match.index > lastIndex) {
      const normalText = cleanTextValue.substring(lastIndex, match.index);
      if (normalText) {
        segments.push({ text: normalText, bold: false });
      }
    }

    // Add bold text
    segments.push({ text: match[1], bold: true });
    lastIndex = match.index + match[0].length;
  }

  // Add remaining normal text
  if (lastIndex < cleanTextValue.length) {
    const normalText = cleanTextValue.substring(lastIndex);
    if (normalText) {
      segments.push({ text: normalText, bold: false });
    }
  }

  // If no segments found (malformed markdown), just remove ** and render
  if (segments.length === 0) {
    doc.text(cleanTextValue.replace(/\*\*/g, ""), { width, lineGap, indent });
    return;
  }

  // Simple approach: render each segment sequentially
  // PDFKit will handle line wrapping naturally
  segments.forEach((segment, index) => {
    // Set appropriate font
    if (segment.bold) {
      doc.font(boldFont).fontSize(fontSize);
    } else {
      doc.font(normalFont).fontSize(fontSize);
    }

    const isLast = index === segments.length - 1;

    // Render segment - let PDFKit handle wrapping
    // Use continued: true for all but the last segment so they flow on the same line
    doc.text(segment.text, {
      width: width,
      lineGap: isLast ? lineGap : 0,
      indent: index === 0 ? indent : 0, // Only indent first segment
      continued: !isLast,
    });
  });

  // Reset to normal font
  doc.font("Helvetica").fontSize(fontSize);
};

const renderStyledReport = (
  doc,
  text,
  metrics = {},
  ucRecommendations = null,
  isDiscoveryReport = false, // Flag to indicate if this is a discovery report
) => {
  const lines = String(text || "").split(/\r?\n/);

  doc.font("Helvetica").fontSize(11);
  doc.fillColor("#111111");

  // Calculate available width
  const availableWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;

  let skipUntilNextSection = false;
  let foundMetricsInterpretation = false;
  let inMetricsGaugeSection = false;
  let inIntroSection = false;
  let introEnded = false;
  let introLines = [];
  let metricsGaugeRendered = false; // Track if metrics gauge was rendered
  let metricsInterpretationRendered = false; // Track if interpretation table was rendered
  let metadataRendered = false; // Track if metadata block has been rendered
  let firstContentSectionStarted = false; // Track if we've started rendering main content

  // Text buffer for paragraph rendering
  let textBuffer = [];

  const renderPlainHeader = (headerText, size = 14) => {
    const cleanedHeader = cleanText(headerText).replace(/:+$/, "").trim();
    if (!cleanedHeader) return;
    doc.moveDown(1);
    doc.font("Helvetica-Bold").fontSize(size).text(cleanedHeader, {
      width: availableWidth,
      lineGap: 4,
    });
    doc.font("Helvetica").fontSize(11);
    doc.moveDown(0.5);
  };

  // Helper to flush buffer
  const flushTextBuffer = () => {
    if (textBuffer.length > 0) {
      const paragraph = textBuffer.join(" ");
      doc.moveDown(0.2);
      renderTextWithBold(doc, cleanText(paragraph), {
        width: availableWidth,
        lineGap: 4,
      });
      textBuffer = [];
      doc.moveDown(0.3); // Small gap after paragraph
    }
  };

  // Check if this is a discovery report and has metrics - render at top
  const hasMetrics =
    metrics &&
    (metrics.gravity !== undefined ||
      metrics.signalCoherence !== undefined ||
      metrics.signalOutput !== undefined ||
      metrics.consciousnessLevel !== undefined ||
      metrics.qgcActivation !== undefined);

  const isDiscovery =
    isDiscoveryReport ||
    text.toLowerCase().includes("structural update report") ||
    text.toLowerCase().includes("discovery report");

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    let line = rawLine.trimEnd();

    if (skipUntilNextSection) {
      const isNextSection =
        /^SECTION\s+\d+/i.test(line) ||
        /^PHASE\s+\d+/i.test(line) ||
        /^##\s+/.test(line) ||
        /^[\-─_]{3,}/.test(line) ||
        isAllCapsHeader(line);

      if (!line.trim()) {
        continue;
      }

      if (!isNextSection) {
        continue;
      }

      skipUntilNextSection = false;
      // Fall through and process this line as a new section header.
    }

    // Skip problematic lines
    if (/^%{10,}/.test(line.trim())) {
      flushTextBuffer();
      drawDivider(doc);
      continue;
    }

    // Title Handling - IMPROVED
    // Matches standard headers OR typically formatted title lines appearing early
    if (
      /^[✨'\(]?\s*EUPHORIAM.*(?:STRUCTURAL|DIAGNOSTIC|ANALYSIS).*REPORT/i.test(
        line,
      ) ||
      /^##\s*EUPHORIAM.*(?:STRUCTURAL|DIAGNOSTIC|ANALYSIS).*REPORT/i.test(
        line,
      ) ||
      (!firstContentSectionStarted &&
        i < 10 &&
        /(?:analysis|diagnostic|structural|quantum)/i.test(line) &&
        line.length < 100 &&
        line.length > 15 &&
        !line.includes(":"))
    ) {
      flushTextBuffer();
      const titleText = line
        .replace(/^[#✨'\(]\s*/, "")
        .replace(/\*\*/g, "")
        .trim();

      doc.moveDown(1);
      doc.font("Helvetica-Bold").fontSize(22).text(titleText, {
        width: availableWidth,
        align: "center",
        lineGap: 4,
      });
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(1);

      // Mark that we've rendered the title
      firstContentSectionStarted = true;
      continue;
    }

    // Capture Metadata Block (e.g., "**Client:** Name" or "Client:  Yashal")
    // If we see a sequence of these, render them as a grid/block
    if (
      (/^\*\*.*:\*\*/.test(line) && line.includes(":")) ||
      (/^(Client|Report Type|Version|Date|Tone):\s+/.test(line) &&
        !metadataRendered)
    ) {
      flushTextBuffer();
      // Check next few lines to see if they are also metadata
      let metadataLines = [line];
      let tempI = i + 1;
      while (tempI < lines.length) {
        const nextL = lines[tempI].trim();
        // Check for both markdown format and plain format metadata
        if (
          (/^\*\*.*:\*\*/.test(nextL) && nextL.includes(":")) ||
          /^(Client|Report Type|Version|Date|Tone):\s+/.test(nextL)
        ) {
          metadataLines.push(nextL);
          tempI++;
        } else if (!nextL) {
          tempI++; // allow one empty line gap if needed, or just stop
          // Actually, standard markdown might just have newlines.
          // If it's a tight block, they usually follow immediately.
        } else {
          break;
        }
      }

      // Check if we have metadata lines (either markdown format or plain format)
      const hasMetadata = metadataLines.length >= 1;

      if (hasMetadata) {
        // It's a metadata block. Render it nicely.
        doc.moveDown(0.5);
        // Draw a light gray box? Or just formatted text.
        // Let's do a key-value layout.

        metadataLines.forEach((metaLine) => {
          // Clean asterisks if present in the data line itself (e.g. "Client: ** Yashal" -> "Client: Yashal")
          let cleanLine = metaLine.replace(/:\s*\*\*\s*/g, ": ");
          const cleanMeta = cleanText(cleanLine).replace(/\*\*/g, ""); // Strip any remaining asterisks

          // parts expected: "Client: Yashal"
          const colonIdx = cleanMeta.indexOf(":");
          if (colonIdx > -1) {
            const key = cleanMeta.substring(0, colonIdx + 1).trim();
            const val = cleanMeta.substring(colonIdx + 1).trim();

            doc.font("Helvetica-Bold").text(key, { continued: true });
            doc.font("Helvetica").text(`  ${val}`);
          } else {
            renderTextWithBold(doc, cleanMeta);
          }
        });

        doc.moveDown(1);
        metadataRendered = true;

        // Advance loop
        i = tempI - 1;
        continue;
      }
    }

    // Intro Section Detection
    if (
      /BEFORE YOU READ THIS DIAGNOSTIC/i.test(line) ||
      /✨\s*BEFORE YOU READ/i.test(line)
    ) {
      flushTextBuffer();
      inIntroSection = true;
      introLines = [];
    }

    if (inIntroSection && !introEnded) {
      // End intro on divider, markdown header, or main report section (SECTION 1, METRICS GAUGE, etc.)
      const isDivider = /^[\-─_]{3,}/.test(line);
      const isSectionStart =
        /^SECTION\s+\d+/i.test(line) || /^STRUCTURE\s+TYPE/i.test(line);
      const isMainContentHeader =
        /^METRICS\s+GAUGE/i.test(line) || /^FRICTION\s+ANALYSIS/i.test(line);
      const isHeader = /^##/.test(line) || /SHORT SUMMARY/i.test(line);

      if (isDivider || isHeader || isSectionStart || isMainContentHeader) {
        introEnded = true;
        inIntroSection = false;
        // Render intro
        if (introLines.length > 0) {
          doc.font("Helvetica-Oblique").fontSize(10).fillColor("#555555");
          introLines.forEach((l) => doc.text(cleanText(l)));
          doc.fillColor("#111111").fontSize(11).font("Helvetica");
          doc.moveDown(1);
        }
        // Fall through so this line (e.g. SECTION 1) is processed as content
      } else {
        introLines.push(line);
        continue; // don't render yet
      }
    }

    // Skip intro lines being collected
    if (inIntroSection && !introEnded) continue;

    // Intercept FRICTION ANALYSIS (or similar friction section) to inject Metrics BEFORE it
    if (
      /##\s+FRICTION\s+ANALYSIS/i.test(line) ||
      /FRICTION\s+ANALYSIS/i.test(line)
    ) {
      flushTextBuffer();
      if (hasMetrics && !metricsGaugeRendered) {
        doc.moveDown(0.5);
        doc.x = doc.page.margins.left;
        doc
          .font("Helvetica-Bold")
          .fontSize(14)
          .text("METRICS GAUGE (Current Snapshot)", {
            width: availableWidth,
            lineGap: 2,
          });
        doc.moveDown(0.3);

        console.log(
          "[diagnosticPdf] Rendering METRICS GAUGE (at Friction Analysis) with metrics:",
          metrics,
        );

        // Render all metrics
        renderMetricLine(doc, "QGC Activation:", metrics.qgcActivation, true);
        renderMetricLine(
          doc,
          "Consciousness Level:",
          metrics.consciousnessLevel,
          false,
        );
        renderMetricLine(doc, "Gravity (Load):", metrics.gravity, true);
        renderMetricLine(
          doc,
          "Signal Coherence:",
          metrics.signalCoherence,
          true,
        );
        renderMetricLine(doc, "Signal Output:", metrics.signalOutput, true);

        metricsGaugeRendered = true;
        doc.moveDown(0.3);
      }

      if (!metricsInterpretationRendered && metricsGaugeRendered) {
        doc.moveDown(0.5);
        doc.x = doc.page.margins.left;
        doc
          .font("Helvetica-Bold")
          .fontSize(12)
          .text("METRICS INTERPRETATION TABLE", {
            width: availableWidth,
            lineGap: 2,
          });
        doc.moveDown(0.3);

        // Try to find custom table data in the future lines of the report
        let tableData = null;
        const searchRegex = /METRICS\s+INTERPRETATION/i;
        const tableHeaderIdx = lines.findIndex(
          (l, idx) => idx > i && searchRegex.test(l),
        );

        if (tableHeaderIdx !== -1) {
          // Found the header later in the doc, let's look for the table characters
          let k = tableHeaderIdx + 1;
          while (k < lines.length && !lines[k].trim()) k++;

          if (
            k < lines.length &&
            (lines[k].includes("|") || /[-]{3,}/.test(lines[k]))
          ) {
            // Supports Both Pipe tables and Dash-separated tables
            // TODO: Advanced parsing if dash separated.
            // For now, reuse pipe logic if pipe exists.
            if (lines[k].includes("|")) {
              const extractedLines = [];
              while (k < lines.length && lines[k].includes("|")) {
                extractedLines.push(lines[k]);
                k++;
              }
              if (extractedLines.length > 0) {
                tableData = extractedLines.map((row) =>
                  row.split("|").map((c) => c.trim()),
                );
              }
            }
          }
        }

        if (tableData && tableData.length > 0) {
          const numCols = tableData[0].length;
          const colWidths = Array(numCols).fill(availableWidth / numCols);
          if (numCols === 4) {
            colWidths[0] = availableWidth * 0.15;
            colWidths[1] = availableWidth * 0.3;
            colWidths[2] = availableWidth * 0.45;
            colWidths[3] = availableWidth * 0.1;
          }
          renderTableData(doc, tableData, colWidths);
        } else {
          drawMetricsInterpretationTable(doc);
        }
        metricsInterpretationRendered = true;
      }

      renderPlainHeader("FRICTION ANALYSIS");
      firstContentSectionStarted = true;
      continue;
    }

    // Check if we've found the METRICS GAUGE section
    if (/##\s+METRICS\s+GAUGE/i.test(line) || /METRICS\s+GAUGE/i.test(line)) {
      flushTextBuffer();
      inMetricsGaugeSection = true;

      // If we already rendered it (e.g. before Friction Analysis), just skip this entire section
      if (metricsGaugeRendered) {
        continue;
      }

      doc.moveDown(0.5);
      doc.x = doc.page.margins.left;
      doc
        .font("Helvetica-Bold")
        .fontSize(14)
        .text("METRICS GAUGE (Current Snapshot)", {
          width: availableWidth,
          lineGap: 2,
        });
      doc.moveDown(0.3);

      console.log(
        "[diagnosticPdf] Rendering METRICS GAUGE with metrics:",
        metrics,
      );

      // Render all metrics using global helpers
      renderMetricLine(doc, "QGC Activation:", metrics.qgcActivation, true);
      renderMetricLine(
        doc,
        "Consciousness Level:",
        metrics.consciousnessLevel,
        false,
      );
      renderMetricLine(doc, "Gravity (Load):", metrics.gravity, true);
      renderMetricLine(doc, "Signal Coherence:", metrics.signalCoherence, true);
      renderMetricLine(doc, "Signal Output:", metrics.signalOutput, true);

      // Small spacing after the metrics section
      doc.moveDown(0.3);
      metricsGaugeRendered = true;

      continue;
    }

    // Skip lines in METRICS GAUGE section until we hit the next section
    if (inMetricsGaugeSection) {
      if (
        (!line.trim() &&
          i + 1 < lines.length &&
          (isAllCapsHeader(lines[i + 1]?.trim()) ||
            /^SECTION\s+\d+/i.test(lines[i + 1]?.trim()) ||
            /^PHASE\s+\d+/i.test(lines[i + 1]?.trim()) ||
            lines[i + 1]?.trim().startsWith("##") ||
            lines[i + 1]?.trim().startsWith("---") ||
            lines[i + 1]?.trim() ===
              "----------------------------------------" ||
            lines[i + 1]?.trim() ===
              "────────────────────────────────────────")) ||
        line === "----------------------------------------" ||
        line === "────────────────────────────────────────" ||
        /^SECTION\s+\d+/i.test(line) ||
        /^PHASE\s+\d+/i.test(line) ||
        /^##\s+/.test(line) ||
        (isAllCapsHeader(line) && !/METRICS\s+GAUGE/i.test(line))
      ) {
        inMetricsGaugeSection = false;
        // Continue processing this line
      } else {
        // Skip this line (it's part of the metrics gauge text we're replacing)
        continue;
      }
    }

    // Check if we've found the Metrics Interpretation Table header
    if (
      /METRICS\s+INTERPRETATION\s+TABLE/i.test(line) ||
      /METRICS INTERPRETATION/i.test(line)
    ) {
      flushTextBuffer();
      if (metricsInterpretationRendered) {
        // If we rendered it already (generic or custom), AND we can't parse a custom table here,
        // we might want to skip. BUT if parsing failed earlier, maybe we should let the text show?

        // Strategy: If we rendered the GENERIC table (meaning no custom data was found earlier),
        // we should try to see if THIS section has custom data we missed (e.g. dash table).
        // For now, let's assume if 'metricsInterpretationRendered' is true, we want to skip.
        // HOWEVER, if the user sees "incorrect table", maybe we should NOT skip if we are just falling back?
        skipUntilNextSection = true;
        continue;
      }

      foundMetricsInterpretation = true;
      doc.moveDown(0.5);
      doc.x = doc.page.margins.left;
      doc
        .font("Helvetica-Bold")
        .fontSize(12)
        .text("METRICS INTERPRETATION TABLE", {
          width: availableWidth,
          lineGap: 2,
        });
      doc.moveDown(0.3);

      // Peek ahead to see if there's a custom table
      let tableLines = [];
      let j = i + 1;
      // Skip empty lines after header
      while (j < lines.length && !lines[j].trim()) j++;

      // Parsing Check
      if (j < lines.length) {
        if (lines[j].includes("|")) {
          // Pipe table logic
          while (j < lines.length && lines[j].includes("|")) {
            tableLines.push(lines[j]);
            j++;
          }
        } else if (lines[j].includes("---") && lines[j].length > 10) {
          // Dash table logic (e.g. Yashal's report)
          // Peek back for headers if they were on separate lines
          let headers = [];
          let headIdx = j - 1;
          while (headIdx >= i + 1) {
            if (lines[headIdx].trim()) headers.unshift(lines[headIdx].trim());
            headIdx--;
          }
          if (headers.length > 0) tableLines.push(headers.join(" | "));

          // Now collect rows
          let k = j;
          while (k < lines.length) {
            let curLine = lines[k].trim();
            if (!curLine) {
              k++;
              continue;
            }
            if (curLine.includes("---") && curLine.length > 10) {
              k++;
              continue;
            }

            // If it looks like a new section, stop
            if (
              isAllCapsHeader(curLine) ||
              curLine.startsWith("##") ||
              curLine.startsWith("SECTION")
            )
              break;

            // Dash tables are often messy. Let's try to group lines into rows.
            // A row typically starts with a metric name.
            if (
              /(QGC Activation|Consciousness Level|Gravity|Signal Coherence|Signal Output)/i.test(
                curLine,
              )
            ) {
              // Extract metric, value, and the rest as interpretation
              const match = curLine.match(/(.*?)\s+(\d+(?:\.\d+)?%?)\s+(.*)/i);
              if (match) {
                tableLines.push(`${match[1]} | ${match[2]} | ${match[3]}`);
              } else {
                // Try to peek ahead for interpretation if it's on next line
                let row = curLine;
                let nextK = k + 1;
                while (
                  nextK < lines.length &&
                  lines[nextK].trim() &&
                  !/(QGC Activation|Consciousness Level|Gravity|Signal Coherence|Signal Output)/i.test(
                    lines[nextK],
                  )
                ) {
                  row += " " + lines[nextK].trim();
                  nextK++;
                }
                // Attempt to split row into 3 parts manually or just use as is
                tableLines.push(row);
                k = nextK - 1;
              }
            }
            k++;
          }
          j = k;
        }
      }

      if (tableLines.length > 0) {
        const tableData = tableLines.map((row) =>
          row.split("|").map((c) => c.trim()),
        );
        if (tableData.length > 0) {
          // ... (render logic)
          const numCols = tableData[0].length;
          const colWidths = Array(numCols).fill(availableWidth / numCols);
          if (numCols === 4) {
            colWidths[0] = availableWidth * 0.15; // Metric
            colWidths[1] = availableWidth * 0.3; // Evidence
            colWidths[2] = availableWidth * 0.45; // Interpretation
            colWidths[3] = availableWidth * 0.1; // Result
          }
          renderTableData(doc, tableData, colWidths);
          i = j - 1; // Advance pointer
          skipUntilNextSection = false; // We handled it
          foundMetricsInterpretation = false;
          metricsInterpretationRendered = true;
          continue;
        }
      }

      // Fallback: If no pipe/dash table found, render the generic Metrics Interpretation Table
      // derived from the current metrics instead of raw text.
      console.log(
        "[diagnosticPdf] No pipe table found for Metrics Interpretation. Rendering generic Metrics Interpretation Table from metrics.",
      );
      drawMetricsInterpretationTable(doc);
      metricsInterpretationRendered = true;
      skipUntilNextSection = true; // Skip raw lines for this section; we've rendered the table.
      continue;
    }

    // Headers (##, ###) - Place generic header check AFTER specific section handlers
    if (/^#{2,6}\s+/.test(line)) {
      flushTextBuffer();
      const level = (line.match(/^#+/) || [""])[0].length;
      const text = line.replace(/^#+\s*/, "").trim();
      const headerSize = level === 2 ? 16 : level === 3 ? 14 : 12;

      doc.moveDown(1.5); // More space before headers
      doc.font("Helvetica-Bold").fontSize(headerSize).text(cleanText(text), {
        width: availableWidth,
        lineGap: 4,
      });
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.5);
      continue;
    }

    if (
      /^SECTION\s+\d+/i.test(line) ||
      /^PHASE\s+\d+/i.test(line) ||
      isAllCapsHeader(line)
    ) {
      flushTextBuffer();
      renderPlainHeader(line, 14);
      firstContentSectionStarted = true;
      continue;
    }

    // Bullets
    if (/^[\-•\*]\s+/.test(line)) {
      flushTextBuffer();
      // Check if this is a metric bullet line (should be skipped if in metrics section)
      const isMetricBullet =
        /(QGC Activation|Consciousness Level|Gravity|Signal Coherence|Signal Output)/i.test(
          line,
        );

      if (isMetricBullet && inMetricsGaugeSection) {
        continue;
      }

      const bulletContent = line.replace(/^[\-•\*]\s+/, "").trim();
      if (!bulletContent || bulletContent === "-") {
        continue;
      }
      const isTreatmentSubBullet =
        /^(\*\*)?(Day\s+\d+|Protector Script:|What You Will Say:|What You Will Do:)/i.test(
          bulletContent,
        );
      doc.moveDown(0.2);
      renderTextWithBold(doc, `•  ${cleanText(bulletContent)}`, {
        width: availableWidth,
        indent: isTreatmentSubBullet ? 36 : 20,
        lineGap: 4,
      });
      continue;
    }

    // Blockquotes (> text)
    if (line.trim().startsWith(">")) {
      flushTextBuffer();
      const quoteContent = line.trim().substring(1).trim();

      doc.moveDown(0.5);
      const currentX = doc.x;
      const currentY = doc.y;

      // Draw left border line
      doc
        .moveTo(doc.page.margins.left + 5, currentY)
        .lineTo(
          doc.page.margins.left + 5,
          currentY +
            doc.heightOfString(cleanText(quoteContent), {
              width: availableWidth - 25,
            }) +
            5,
        )
        .lineWidth(2)
        .strokeColor("#cccccc")
        .stroke();

      doc.fillColor("#555555");
      renderTextWithBold(doc, cleanText(quoteContent), {
        width: availableWidth - 25,
        indent: 15,
        lineGap: 4,
        oblique: true,
      });

      doc.fillColor("#111111");
      doc.moveDown(0.5);
      continue;
    }

    // Dividers
    if (/^[\-─_]{3,}/.test(line)) {
      flushTextBuffer();
      drawDivider(doc);
      continue;
    }

    // Default Text Render - Buffer for paragraph joining
    if (line.trim()) {
      // If it looks like a "Metadata" line but we've already rendered metadata,
      // or it's just plain text, buffer it.
      textBuffer.push(line.trim());
    } else {
      flushTextBuffer();
    }
  }

  // Final flush
  flushTextBuffer();

  // After processing all lines, check if metrics sections were rendered
  // If we reached here and haven't rendered metrics yet but have them,
  // it might be because the text report didn't have the header 'METRICS GAUGE'.
  // In that case, we append them at the end.
  if (hasMetrics && !metricsGaugeRendered && isDiscovery) {
    console.log(
      "[diagnosticPdf] Force-rendering METRICS GAUGE for discovery report with metrics (End of doc):",
      metrics,
    );

    // Use renderVisualGauge for consistent visual style
    renderVisualGauge(doc, metrics);
    metricsGaugeRendered = true;

    // Add METRICS INTERPRETATION TABLE right after gauge
    doc.moveDown(0.8);
    doc.x = doc.page.margins.left;
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("METRICS INTERPRETATION TABLE", {
        width: availableWidth,
        lineGap: 2,
      });
    doc.moveDown(0.3);
    drawMetricsInterpretationTable(doc);
    metricsInterpretationRendered = true;
  }

  // FINALLY: Render UC Recommendations if provided and not already rendered manually in text
  if (
    ucRecommendations &&
    (ucRecommendations.phase1.length > 0 ||
      ucRecommendations.phase2.length > 0 ||
      ucRecommendations.phase3.length > 0)
  ) {
    // Only render if we didn't see a "UC MODULE RECOMMENDATION" section in the text
    // (Actually, better to always render it for consistency since the AI output might be basic)
    renderUnlimitedCreatedRecommendations(doc, ucRecommendations);
  }
};

/**
 * Extract week number from title, handling "Week One", "Week 12", "Week Seven (B)" etc.
 */
const extractWeekFromTitle = (title) => {
  if (!title) return null;

  const titleLower = title.toLowerCase();

  // Handle "Week Seven (B)" or "Week 7 (B)" -> "7B"
  if (
    titleLower.includes("week seven (b)") ||
    titleLower.includes("week 7 (b)") ||
    (titleLower.includes("week seven") && titleLower.includes("(b)"))
  ) {
    return "7B";
  }

  // Handle numeric weeks: "Week 12", "Week 4"
  const weekMatch = title.match(/week\s+(\d+)/i);
  if (weekMatch) {
    const weekNum = parseInt(weekMatch[1], 10);
    // Check if it's followed by (B)
    if (titleLower.includes(`week ${weekNum} (b)`)) {
      return "7B";
    }
    return weekNum;
  }

  // Handle written weeks: "Week One", "Week Two", etc.
  const weekNames = {
    one: 1,
    two: 2,
    three: 3,
    four: 4,
    five: 5,
    six: 6,
    seven: 7,
    eight: 8,
    nine: 9,
    ten: 10,
    eleven: 11,
    twelve: 12,
  };

  for (const [name, num] of Object.entries(weekNames)) {
    if (titleLower.includes(`week ${name}`)) {
      // Check if it's "Week Seven (B)"
      if (num === 7 && titleLower.includes("(b)")) {
        return "7B";
      }
      return num;
    }
  }

  return null;
};

/**
 * Fetch course videos from Kajabi and build week-to-title mapping
 */
const fetchCourseWeekTitles = async (courseId = "2148785745") => {
  try {
    // Dynamic import for ES module
    const { getCourseWithModulesAndLessons, extractVideosFromCourse } =
      await import("../controllers/kajabi.js");
    const courseData = await getCourseWithModulesAndLessons(courseId);
    const videos = extractVideosFromCourse(courseData);

    // Build mapping: week number -> video title
    const weekToTitle = {};
    videos.forEach((video) => {
      const week = extractWeekFromTitle(video.title);
      if (week && !weekToTitle[week]) {
        // Prefer "Live & Journey" videos, but fallback to any week video
        if (
          video.title.toLowerCase().includes("live & journey") ||
          !weekToTitle[week]
        ) {
          weekToTitle[week] = video.title;
        }
      }
    });

    return weekToTitle;
  } catch (err) {
    console.error("[diagnosticPdf] Error fetching course videos:", err.message);
    return {};
  }
};

/**
 * Generate week-wise recommendations for Unlimited Created videos
 * based on user's current metrics and state
 */
const generateUnlimitedCreatedRecommendations = async (
  metrics = {},
  aiReport = {},
  weekTitles = {},
) => {
  const gravity = metrics.gravity || 0;
  const signalOutput = metrics.signalOutput || 0;
  const signalCoherence = metrics.signalCoherence || 0;
  const consciousnessLevel = metrics.consciousnessLevel || 0;
  const qgcActivation = metrics.qgcActivation || 0;

  // Extract structure type and vortex status from report if available
  const reportText =
    typeof aiReport === "string" ? aiReport : JSON.stringify(aiReport);
  const hasHighGravity = gravity >= 70;
  const hasLowSignalOutput = signalOutput < 30;
  const hasLowCoherence = signalCoherence < 70;
  const hasLowCL = consciousnessLevel < 2.5;
  const hasLowQGC = qgcActivation < 40;

  // Use actual video titles from Kajabi if available, otherwise use fallback descriptions
  const getWeekTitle = (week) => {
    if (weekTitles[week]) {
      return weekTitles[week];
    }
    // Fallback descriptions
    const fallbacks = {
      2: "Rising Out of Environment (Sovereignty Activation)",
      3: "Identity as Creator (Code Holder Embodiment)",
      4: "Fear Field & Power Expression",
      6: "Lineage Rules: Father/Grandfather/Maternal War Coding",
      "7B": "Visibility, Witch Lineage, Power Safety",
      8: "Protection Parts: Oracle, Sage, Veil Holder, Fox",
      9: "Merging Timelines: Past–Present–Future",
      10: "Money Mapping & Prosperity Permission",
      11: "Higher Octave Identity Flip",
      12: "Integration of Keys + Leadership Embodiment",
    };
    return fallbacks[week] || `Week ${week}`;
  };

  const recommendations = {
    phase1: [],
    phase2: [],
    phase3: [],
  };

  // PHASE 1 — Remove Gravity & Interference
  // Recommended when: High gravity, low signal output, or low coherence
  if (hasHighGravity || hasLowSignalOutput || hasLowCoherence) {
    // Week 4 — Fear Field & Power Expression (for high gravity or fear-based patterns)
    if (
      hasHighGravity ||
      (reportText && /fear|anxiety|worry/i.test(reportText))
    ) {
      recommendations.phase1.push({ week: 4, title: getWeekTitle(4) });
    }

    // Week 6 — Lineage Rules (for lineage patterns or inherited structures)
    if (
      reportText &&
      /lineage|father|mother|grandfather|family|inherited/i.test(reportText)
    ) {
      recommendations.phase1.push({ week: 6, title: getWeekTitle(6) });
    }

    // Week 7B — Visibility, Witch Lineage, Power Safety (for visibility issues or power safety)
    if (
      hasLowSignalOutput ||
      (reportText &&
        /visibility|invisible|witch|power.*safety|safety.*power/i.test(
          reportText,
        ))
    ) {
      recommendations.phase1.push({ week: "7B", title: getWeekTitle("7B") });
    }

    // Week 8 — Protection Parts (for protection patterns or avoidance)
    if (
      reportText &&
      /protection|protector|avoidance|oracle|sage|veil|fox/i.test(reportText)
    ) {
      recommendations.phase1.push({ week: 8, title: getWeekTitle(8) });
    }
  }

  // PHASE 2 — Stabilise Identity
  // Recommended when: Low CL, low QGC, or identity instability
  if (
    hasLowCL ||
    hasLowQGC ||
    (reportText && /identity|structure.*type|sovereignty/i.test(reportText))
  ) {
    // Week 2 — Rising Out of Environment (for environment/sovereignty issues)
    if (
      hasLowCL ||
      (reportText && /environment|sovereignty|rising/i.test(reportText))
    ) {
      recommendations.phase2.push({ week: 2, title: getWeekTitle(2) });
    }

    // Week 3 — Identity as Creator (for identity/creator embodiment)
    if (
      hasLowQGC ||
      (reportText &&
        /creator|identity|embodiment|code.*holder/i.test(reportText))
    ) {
      recommendations.phase2.push({ week: 3, title: getWeekTitle(3) });
    }
  }

  // PHASE 3 — Prosperity & Leadership
  // Recommended when: Signal output is improving, CL is higher, or prosperity/leadership themes
  if (
    signalOutput >= 30 ||
    consciousnessLevel >= 2.5 ||
    (reportText &&
      /prosperity|money|leadership|timeline|integration/i.test(reportText))
  ) {
    // Week 9 — Merging Timelines (for timeline work or integration)
    if (
      reportText &&
      /timeline|past.*present|future|merging/i.test(reportText)
    ) {
      recommendations.phase3.push({ week: 9, title: getWeekTitle(9) });
    }

    // Week 10 — Money Mapping & Prosperity Permission (for money/prosperity work)
    if (
      reportText &&
      /money|prosperity|abundance|wealth|financial|permission/i.test(reportText)
    ) {
      recommendations.phase3.push({ week: 10, title: getWeekTitle(10) });
    }

    // Week 11 — Higher Octave Identity Flip (for advanced identity work)
    if (
      consciousnessLevel >= 3.0 ||
      (reportText && /higher.*octave|identity.*flip/i.test(reportText))
    ) {
      recommendations.phase3.push({ week: 11, title: getWeekTitle(11) });
    }

    // Week 12 — Integration of Keys + Leadership Embodiment (for integration/leadership)
    if (
      consciousnessLevel >= 3.5 ||
      (reportText && /integration|leadership|keys|embodiment/i.test(reportText))
    ) {
      recommendations.phase3.push({ week: 12, title: getWeekTitle(12) });
    }
  }

  // If no recommendations were generated, provide default based on primary need
  if (
    recommendations.phase1.length === 0 &&
    recommendations.phase2.length === 0 &&
    recommendations.phase3.length === 0
  ) {
    // Default: Start with Phase 1 if high gravity, otherwise Phase 2
    if (hasHighGravity) {
      recommendations.phase1.push({ week: 4, title: getWeekTitle(4) });
      recommendations.phase1.push({ week: 8, title: getWeekTitle(8) });
    } else {
      recommendations.phase2.push({ week: 2, title: getWeekTitle(2) });
      recommendations.phase2.push({ week: 3, title: getWeekTitle(3) });
    }
  }

  return recommendations;
};

/**
 * Render Unlimited Created recommendations section in PDF
 */
const renderUnlimitedCreatedRecommendations = (doc, recommendations) => {
  const sectionWidth =
    doc.page.width - doc.page.margins.left - doc.page.margins.right;

  doc.moveDown(1);
  doc
    .font("Helvetica-Bold")
    .fontSize(14)
    .text("UNLIMITED CREATOR RECOMMENDATION ENGINE", {
      width: sectionWidth,
      lineGap: 2,
    });
  doc.moveDown(0.5);

  // PHASE 1
  if (recommendations.phase1.length > 0) {
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("PHASE 1 — Remove Gravity & Interference", {
        width: sectionWidth,
        lineGap: 2,
      });
    doc.moveDown(0.3);
    recommendations.phase1.forEach((rec) => {
      doc
        .font("Helvetica")
        .fontSize(11)
        // Use simple ASCII dash instead of a special bullet to avoid encoding issues like "%Ï"
        .text(`- Week ${rec.week} — ${rec.title}`, {
          width: sectionWidth,
          lineGap: 1.5,
          indent: 10,
        });
    });
    doc.moveDown(0.4);
  }

  // PHASE 2
  if (recommendations.phase2.length > 0) {
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("PHASE 2 — Stabilise Identity", {
        width: sectionWidth,
        lineGap: 2,
      });
    doc.moveDown(0.3);
    recommendations.phase2.forEach((rec) => {
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(`- Week ${rec.week} — ${rec.title}`, {
          width: sectionWidth,
          lineGap: 1.5,
          indent: 10,
        });
    });
    doc.moveDown(0.4);
  }

  // PHASE 3
  if (recommendations.phase3.length > 0) {
    doc
      .font("Helvetica-Bold")
      .fontSize(12)
      .text("PHASE 3 — Prosperity & Leadership", {
        width: sectionWidth,
        lineGap: 2,
      });
    doc.moveDown(0.3);
    recommendations.phase3.forEach((rec) => {
      doc
        .font("Helvetica")
        .fontSize(11)
        .text(`- Week ${rec.week} — ${rec.title}`, {
          width: sectionWidth,
          lineGap: 1.5,
          indent: 10,
        });
    });
    doc.moveDown(0.4);
  }

  doc.font("Helvetica").fontSize(11); // Reset font
};

const generateDiagnosticPdf = (diagnostic) =>
  new Promise(async (resolve, reject) => {
    try {
      // ── Route: IRL report uses its own premium template ───────────────────
      const reportType =
        diagnostic.report_type ||
        diagnostic.data?.report_type ||
        diagnostic.data?.structuredPacket?.report_type ||
        "full";

      if (reportType === "invisible_red_line") {
        return resolve(await generateIrlReportPdf(diagnostic));
      }

      // ── Default full-report path below ────────────────────────────────────
      const outputDir = path.join(
        __dirname,
        "..",
        "..",
        "reports",
        "diagnostics",
      );
      ensureDir(outputDir);

      const filePath = path.join(
        outputDir,
        `diagnostic-${diagnostic.id || Date.now()}.pdf`,
      );

      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);

      stream.on("finish", () => resolve(filePath));
      stream.on("error", reject);

      doc.pipe(stream);

      // --- ADDED LOGO ---
      // --- ADDED LOGO ---
      // Logic: try environment URL/path first -> fetch if URL -> use if path -> fallback to local asset
      try {
        const logoEnv = process.env.LOGO_URL;
        // Fallback local path
        const localLogoPath = path.join(__dirname, "..", "assets", "logo.png");
        let logoBuffer = null;

        if (logoEnv) {
          if (logoEnv.startsWith("http://") || logoEnv.startsWith("https://")) {
            // Fetch URL
            try {
              const response = await axios.get(logoEnv, {
                responseType: "arraybuffer",
              });
              logoBuffer = Buffer.from(response.data, "binary");
            } catch (err) {
              console.log(
                "[diagnosticPdf] Failed to fetch logo from URL:",
                err.message,
              );
            }
          } else {
            // Treat as local file path
            if (fs.existsSync(logoEnv)) {
              logoBuffer = logoEnv;
            }
          }
        }

        // Fallback: If no buffer yet (either no env, or fetch failed), try default local asset
        if (!logoBuffer && fs.existsSync(localLogoPath)) {
          logoBuffer = localLogoPath;
        }

        // Draw the logo if we have a buffer/path
        if (logoBuffer) {
          doc.image(logoBuffer, doc.page.width / 2 - 25, 30, { width: 50 });
          doc.moveDown(3);
        } else {
          // No logo available at all
          doc.moveDown(2);
        }
      } catch (err) {
        console.error("Error loading logo:", err);
        doc.moveDown(2);
      }
      // ------------------

      const data = diagnostic.data || {};
      const profile = data.profile || {};
      const aiReport = data.aiReport || {};
      let metrics = normalizeDiagnosticMetrics(data.metrics || {});

      if (typeof aiReport === "string") {
        const {
          extractMetricsFromReport,
        } = require("../helpers/euphoriamChatbot");
        const extractedMetrics = extractMetricsFromReport(aiReport);
        metrics = normalizeDiagnosticMetrics({
          ...extractedMetrics,
          ...metrics,
          gravity: metrics.gravity ?? extractedMetrics.gravity,
          signalCoherence:
            metrics.signalCoherence ?? extractedMetrics.signalCoherence,
          signalOutput: metrics.signalOutput ?? extractedMetrics.signalOutput,
          consciousnessLevel:
            metrics.consciousnessLevel ?? extractedMetrics.consciousnessLevel,
          qgcActivation:
            metrics.qgcActivation ?? extractedMetrics.qgcActivation,
        });
        console.log("[diagnosticPdf] Metrics after extraction:", metrics);
      }

      const snapshotCl = normalizeClLevel(data.structure_snapshot?.cl_level);
      if (
        snapshotCl != null &&
        (metrics.consciousnessLevel == null ||
          Number(metrics.consciousnessLevel) > 5)
      ) {
        metrics.consciousnessLevel = snapshotCl;
      }
      metrics = normalizeDiagnosticMetrics(metrics);

      if (typeof aiReport === "string") {
        console.log("[diagnosticPdf] aiReport typeof:", typeof aiReport);
        console.log("[diagnosticPdf] aiReport head:", aiReport.slice(0, 200));
        console.log("[diagnosticPdf] Metrics for PDF:", metrics);

        // Strip any prefix messages like "I'm generating your discovery report now..." before validation
        let cleanedReport = aiReport;
        // Remove common prefix patterns that AI might add before the actual report
        // Look for patterns like "I'm generating..." followed by "---" or "##" or "EUPHORIAM"
        const prefixPatterns = [
          /^I'm generating[.\s\S]*?Please hold on[.\s\S]*?(?=\n---|\n##|EUPHORIAM|✨|────────────────)/i,
          /^I'm generating[.\s\S]*?(?=\n---|\n##|EUPHORIAM|✨|────────────────)/i,
          /^Please hold on[.\s\S]*?(?=\n---|\n##|EUPHORIAM|✨|────────────────)/i,
          /^Generating your report[.\s\S]*?(?=\n---|\n##|EUPHORIAM|✨|────────────────)/i,
        ];

        for (const pattern of prefixPatterns) {
          const match = cleanedReport.match(pattern);
          if (match) {
            // Find where the actual report starts (after the prefix)
            const prefixEnd = match.index + match[0].length;
            cleanedReport = cleanedReport.substring(prefixEnd).trimStart();
            break; // Only remove one prefix
          }
        }

        // Also check if report starts with "---" after some text - extract everything from "---" onwards
        const dividerIndex = cleanedReport.indexOf("\n---");
        if (dividerIndex > 0 && dividerIndex < 200) {
          // There's text before the divider, likely a prefix message
          cleanedReport = cleanedReport.substring(dividerIndex + 1).trimStart();
        }

        // Allow: legacy divider-led reports, intro-led reports, or title pages
        // that contain the intro within the first chunk.
        const trimmed = cleanedReport.trimStart();
        const startsWithDivider = trimmed.startsWith(
          "----------------------------------------",
        );
        const startsWithIntro = trimmed.startsWith(
          "✨ BEFORE YOU READ THIS DIAGNOSTIC",
        );
        const containsIntroEarly =
          !startsWithIntro &&
          trimmed.slice(0, 500).includes("BEFORE YOU READ THIS DIAGNOSTIC");
        const startsWithTitle = trimmed
          .toUpperCase()
          .startsWith("EUPHORIAM DIAGNOSTIC REPORT");
        const startsWithFullTitle = /^EUPHORIAM.*DIAGNOSTIC REPORT/i.test(
          trimmed,
        );
        // Check for markdown format (--- followed by ## header, or just ## header)
        const hasMarkdownHeader =
          /^---+[\s\n]*##\s*EUPHORIAM.*STRUCTURAL UPDATE REPORT/i.test(
            trimmed,
          ) ||
          /^##\s*EUPHORIAM.*STRUCTURAL UPDATE REPORT/i.test(trimmed) ||
          /^EUPHORIAM.*REPORT/i.test(trimmed);
        const startsWithMarkdownHeader = /^#+\s*EUPHORIAM/i.test(trimmed);
        const startsWithMarkdownDivider =
          /^---+/.test(trimmed) || /^───+/.test(trimmed);
        // Phase C format: starts with "YOUR LIVED CONSTRAINT" section
        // Normalize potential markdown emphasis or header markers for Phase C detection
        const normalizedPhaseC = trimmed.replace(/^\s*(\*{1,3}|#+)\s*/, "");
        const startsWithPhaseC =
          /^YOUR\s+LIVED\s+CONSTRAINT/i.test(normalizedPhaseC) ||
          /^SECTION\s+1|^STRUCTURE\s+TYPE/i.test(normalizedPhaseC) ||
          /^1\.\s*STRUCTURE\s+TYPE|^##?\s*YOUR\s+LIVED\s+CONSTRAINT/i.test(
            normalizedPhaseC,
          );

        if (
          !startsWithDivider &&
          !startsWithIntro &&
          !containsIntroEarly &&
          !startsWithTitle &&
          !startsWithFullTitle &&
          !hasMarkdownHeader &&
          !startsWithMarkdownHeader &&
          !startsWithMarkdownDivider &&
          !startsWithPhaseC
        ) {
          const head = cleanedReport.slice(0, 300);

          // Check for typical AI refusal patterns
          const isRefusal =
            /i'm sorry|can't assist|cannot assist|policy|guidelines|unsafe/i.test(
              head,
            );

          const err = new Error(
            isRefusal
              ? `AI refused to generate the report. Response: "${head.trim()}"`
              : `aiReport does not start with a recognized header. First 300 chars:\n${head}`,
          );
          err.code = isRefusal
            ? "AI_REPORT_REFUSAL"
            : "AI_REPORT_TEMPLATE_MISMATCH";
          throw err;
        }

        // Generate recommendations BEFORE rendering report so they can be inserted after summary
        const weekTitles = await fetchCourseWeekTitles("2148785745").catch(
          () => ({}),
        );
        const ucRecommendations = await generateUnlimitedCreatedRecommendations(
          metrics,
          cleanedReport,
          weekTitles,
        );

        // Detect if this is a discovery report
        const isDiscoveryReport =
          diagnostic.title?.toLowerCase().includes("discovery") ||
          diagnostic.title?.toLowerCase().includes("chat report") ||
          cleanedReport.toLowerCase().includes("structural update report") ||
          cleanedReport.toLowerCase().includes("discovery report");

        const {
          scrubConsciousnessGaugeInReportText,
          formatTreatmentPlanSubpoints,
        } = require("../helpers/euphoriamChatbot");
        cleanedReport = scrubConsciousnessGaugeInReportText(
          cleanedReport,
          metrics,
        );
        cleanedReport = formatTreatmentPlanSubpoints(cleanedReport);

        // Always ensure x position is at left margin before processing any line
        doc.x = doc.page.margins.left;
        // Render report with recommendations passed in (will be inserted after summary)
        renderStyledReport(
          doc,
          cleanedReport,
          metrics,
          ucRecommendations,
          isDiscoveryReport,
        );

        // Optional metadata on a new page (after the report)
        doc.addPage();
        const metadataWidth =
          doc.page.width - doc.page.margins.left - doc.page.margins.right;
        doc.font("Helvetica-Bold").fontSize(14).text("Diagnostic Metadata", {
          width: metadataWidth,
          lineGap: 2,
        });
        doc.moveDown(0.6);
        doc.font("Helvetica").fontSize(11);
        doc.text(`Title: ${diagnostic.title || "Diagnostic"}`, {
          width: metadataWidth,
          lineGap: 2,
        });
        doc.text(`Generated At: ${new Date().toLocaleString()}`, {
          width: metadataWidth,
          lineGap: 2,
        });
        doc.text(
          `Client: ${profile.name || "N/A"} (${profile.email || "N/A"})`,
          {
            width: metadataWidth,
            lineGap: 2,
          },
        );

        // doc.text(`User ID: ${diagnostic.userId || "N/A"}`, {
        //   width: metadataWidth,
        //   lineGap: 2,
        // });
        // doc.moveDown(0.6);
        // doc.text(`Customer ID: ${data.customerId || "N/A"}`, {
        //   width: metadataWidth,
        //   lineGap: 2,
        // });
        // doc.text(`Site ID: ${data.siteId || "N/A"}`, {
        //   width: metadataWidth,
        //   lineGap: 2,
        // });
        // doc.text(
        //   `Kajabi Contact ID: ${data.rawSource?.kajabiContactId ?? "N/A"}`,
        //   {
        //     width: metadataWidth,
        //     lineGap: 2,
        //   }
        // );
        // doc.text(
        //   `Kajabi Customer ID: ${data.rawSource?.kajabiCustomerId ?? "N/A"}`,
        //   {
        //     width: metadataWidth,
        //     lineGap: 2,
        //   }
        // );

        doc.end();
        return;
      }

      const reportTitle =
        aiReport?.headline?.title ||
        aiReport?.headline ||
        "Euphoriam Diagnostic Report";
      const titleWidth =
        doc.page.width - doc.page.margins.left - doc.page.margins.right;
      doc.fontSize(20).text(reportTitle, {
        align: "center",
        width: titleWidth,
        lineGap: 2,
      });
      doc.moveDown();
      doc.fontSize(12).text(`Title: ${diagnostic.title || "Diagnostic"}`, {
        width: titleWidth,
        lineGap: 2,
      });
      doc.text(`Generated At: ${new Date().toLocaleString()}`, {
        width: titleWidth,
        lineGap: 2,
      });
      doc.text(`Client: ${profile.name || "N/A"} (${profile.email || "N/A"})`, {
        width: titleWidth,
        lineGap: 2,
      });
      // doc.text(`User ID: ${diagnostic.userId || "N/A"}`, {
      //   width: titleWidth,
      //   lineGap: 2,
      // });

      const isV2 = aiReport?.meta?.version === 2;

      if (!isV2) {
        addSection(doc, "Summary", [
          aiReport.summary || "No summary provided.",
        ]);
        addSection(
          doc,
          "Readiness Stage",
          [
            aiReport.readinessStage || "Not specified",
            aiReport.productGuidance
              ? `Guidance: ${aiReport.productGuidance}`
              : null,
          ].filter(Boolean),
        );

        addList(doc, "Strengths", aiReport.strengths);
        addList(doc, "Current Challenges", aiReport.currentChallenges);
        addList(doc, "Recommended Focus", aiReport.recommendedFocus);
        addList(doc, "Next Steps", aiReport.nextSteps);
      } else {
        const before = aiReport.beforeYouRead || {};
        addSection(doc, before.title || "Before You Read", before.lines || []);

        const facts = aiReport.facts || {};
        addSection(
          doc,
          "Facts (from your account)",
          [
            facts.memberSince ? `Member since: ${facts.memberSince}` : null,
            `Sign-ins: ${facts.signInCount ?? profile.signInCount ?? 0}`,
            `Net revenue: ${facts.netRevenue ?? profile.netRevenue ?? 0}`,
          ].filter(Boolean),
        );

        const products = facts.products || data.products || [];
        addSection(
          doc,
          "Products / Access",
          (products || []).map((p) => {
            const title = p.title || p.id || "Product";
            const type = p.type ? ` (${p.type})` : "";
            return `${title}${type}`;
          }),
        );

        const offers = facts.offers || data.offers || [];
        addSection(
          doc,
          "Offers",
          (offers || []).map((o) => {
            const title = o.title || "Offer";
            const price =
              o.price !== undefined && o.price !== null ? ` — ${o.price}` : "";
            return `${title}${price}`;
          }),
        );

        const courses = facts.courses || metrics.assessments || {};
        addSection(doc, "Course Assessments", [
          `Courses: ${courses.coursesCount ?? 0}`,
          `Assessments: total=${courses.totalAssessments ?? 0}, completed=${
            courses.completed ?? 0
          }, pending=${courses.pending ?? 0}`,
          `Completion: ${courses.completionPercentage ?? 0}%`,
          `Pass rate: ${courses.passRate ?? 0}%`,
        ]);

        const gauge = aiReport.metricsGauge || {
          qgcActivation: metrics.qgcActivation,
          consciousnessLevel: metrics.consciousnessLevel,
          gravity: metrics.gravity,
          signalCoherence: metrics.signalCoherence,
          signalOutput: metrics.signalOutput,
        };

        drawMetricsTable(doc, gauge);

        // Add Metrics Interpretation Table
        doc.moveDown(0.5);
        doc
          .font("Helvetica-Bold")
          .fontSize(12)
          .text("METRICS INTERPRETATION TABLE");
        doc.moveDown(0.3);
        drawMetricsInterpretationTable(doc);

        const sections = Array.isArray(aiReport.sections)
          ? aiReport.sections
          : [];
        for (const s of sections) {
          addSection(doc, s.title || "Section", s.body || []);
          addSection(
            doc,
            "Evidence",
            Array.isArray(s.evidence) ? s.evidence.map((e) => `- ${e}`) : [],
          );
        }

        const rec = aiReport.recommendationEngine || {};
        const phases = Array.isArray(rec.phases) ? rec.phases : [];
        for (const p of phases) {
          addList(doc, p.title || "Recommendation Phase", p.items || []);
        }

        // Add Unlimited Created week-wise recommendations
        // Fetch course videos to get actual titles
        const weekTitles = await fetchCourseWeekTitles("2148785745").catch(
          () => ({}),
        );
        const ucRecommendations = await generateUnlimitedCreatedRecommendations(
          metrics,
          aiReport,
          weekTitles,
        );
        renderUnlimitedCreatedRecommendations(doc, ucRecommendations);

        const finalSummary = aiReport.finalSummary || {};
        addList(
          doc,
          finalSummary.title || "Final Summary",
          finalSummary.bullets || [],
        );
      }

      addSection(
        doc,
        "Products",
        (data.products || []).map((p) => {
          const title = p.title || p.id || "Product";
          const type = p.type ? ` (${p.type})` : "";
          return `${title}${type}`;
        }),
      );

      // Back-compat only: older data shape (not used in v2)
      const assessmentProgress = data.assessments?.progress || [];
      if (assessmentProgress.length > 0) {
        addList(
          doc,
          "Assessments",
          assessmentProgress.map((a) => {
            const status = a.status || "pending";
            return `Assessment ${a.assessmentId}: ${status}`;
          }),
        );
      }

      // addSection(doc, "Raw Source", [
      //   `Customer ID: ${data.customerId || "N/A"}`,
      //   `Kajabi Contact ID: ${data.rawSource?.kajabiContactId ?? "N/A"}`,
      //   `Site ID: ${data.siteId || "N/A"}`,
      // ]);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });

module.exports = { generateDiagnosticPdf, generateIrlReportPdf };
