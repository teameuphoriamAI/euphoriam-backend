const fs = require("fs");
const path = require("path");
const PDFDocument = require("pdfkit");

const ensureDir = (dirPath) => {
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { recursive: true });
  }
};

const addSection = (doc, title, bodyLines) => {
  if (!bodyLines || bodyLines.length === 0) return;
  const sectionWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.moveDown(0.6);
  doc.fontSize(13).text(title, { 
    underline: true,
    width: sectionWidth,
    lineGap: 2,
  });
  doc.moveDown(0.2);
  bodyLines.forEach((line) => doc.fontSize(11).text(line, {
    width: sectionWidth,
    lineGap: 2,
  }));
};

const addList = (doc, title, items) => {
  if (!items || items.length === 0) return;
  const listWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  doc.moveDown(0.6);
  doc.fontSize(13).text(title, { 
    underline: true,
    width: listWidth,
    lineGap: 2,
  });
  doc.moveDown(0.2);
  items.forEach((item) => doc.fontSize(11).text(`• ${item}`, {
    width: listWidth,
    lineGap: 2,
  }));
};

const renderGauge = (value) => {
  const v = Math.max(0, Math.min(100, Number(value || 0)));
  const totalBlocks = 12;
  const filled = Math.round((v / 100) * totalBlocks);
  const empty = totalBlocks - filled;

  const filledBlock = "█".repeat(filled);
  const emptyBlock = "░".repeat(empty); // lighter block
  return `${filledBlock}${emptyBlock} ${v}%`;
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
  const startX = doc.x;
  let y = doc.y;
  const rowHeight = 20;
  const colWidths = [150, 150]; // Adjust as needed

  const tableData = [
    ["Metric", "Value"],
    ["QGC Activation", `${metrics.qgcActivation ?? "N/A"}%`],
    ["Consciousness Level", `${metrics.consciousnessLevel ?? "N/A"}%`],
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
  const startX = doc.x;
  let y = doc.y;
  const pageWidth = doc.page.width;
  const pageMargins = doc.page.margins;
  const availableWidth = pageWidth - pageMargins.left - pageMargins.right;
  
  // Column widths for 5 columns
  const colWidths = [
    availableWidth * 0.18, // Metric
    availableWidth * 0.22, // What It Represents
    availableWidth * 0.20, // Low (0-39)
    availableWidth * 0.20, // Mid (40-69)
    availableWidth * 0.20, // High (70-100)
  ];

  const tableData = [
    // Header row
    [
      "Metric",
      "What It Represents",
      "Low (0-39)",
      "Mid (40-69)",
      "High (70-100)",
    ],
    // QGC Activation
    [
      "QGC Activation",
      "Access to your native creation codes",
      "Codes dormant; expression feels blocked",
      "Codes intermittent; talent present, inconsistent",
      "Codes online; expression is potent and clear",
    ],
    // Consciousness Level
    [
      "Consciousness Level",
      "Vantage point of perception and authorship",
      "Reactive/survival-led perception",
      "Mixed perception; oscillates under stress",
      "Author-level perception; stable self-leadership",
    ],
    // Gravity
    [
      "Gravity",
      "Pull of old identity and inherited roles",
      "Low pull; change is easier to sustain",
      "Moderate pull; requires structure to stabilize",
      "Strong pull; loyalty patterns dominate unless addressed",
    ],
    // Signal Coherence
    [
      "Signal Coherence",
      "Alignment between truth, emotion, choice, action",
      "Fragmented signal; mixed outcomes",
      "Partial alignment; results come with effort",
      "Clean alignment; reality responds quickly",
    ],
    // Signal Output
    [
      "Signal Output",
      "Broadcast strength to reality (IP-protected)",
      "Low broadcast; muted impact/traction",
      "Moderate broadcast; traction with consistency",
      "High broadcast; strong impact, visibility, manifestation",
    ],
  ];

  const headerRowHeight = 25;
  const dataRowHeight = 35; // Taller rows for multi-line text

  // Draw header row
  doc.font("Helvetica-Bold").fontSize(9);
  let x = startX;
  tableData[0].forEach((cell, j) => {
    doc.rect(x, y, colWidths[j], headerRowHeight).stroke();
    doc.text(cell, x + 3, y + 5, {
      width: colWidths[j] - 6,
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
    const estimatedRowHeight = dataRowHeight;
    if (y + estimatedRowHeight > doc.page.height - doc.page.margins.bottom) {
      doc.addPage();
      y = doc.page.margins.top;
    }
    
    x = startX;
    
    // Calculate row height based on longest cell content
    let maxLines = 1;
    row.forEach((cell, cellIndex) => {
      // Estimate lines by character count and width
      const cellWidth = colWidths[cellIndex] - 6;
      const estimatedCharsPerLine = Math.floor(cellWidth / 4); // Rough estimate: 4px per char
      const cellLines = Math.ceil(cell.length / estimatedCharsPerLine) || 1;
      maxLines = Math.max(maxLines, cellLines);
    });
    const currentRowHeight = Math.max(dataRowHeight, maxLines * 10 + 10);

    row.forEach((cell, j) => {
      doc.rect(x, y, colWidths[j], currentRowHeight).stroke();
      doc.text(cell, x + 3, y + 5, {
        width: colWidths[j] - 6,
        align: "left",
        lineGap: 1,
      });
      x += colWidths[j];
    });
    y += currentRowHeight;
  }

  doc.moveDown(2);
  // Reset x position to left margin after drawing table
  doc.x = doc.page.margins.left;
  doc.font("Helvetica").fontSize(11); // Reset to default font size
};

const isAllCapsHeader = (line) =>
  /^[A-Z0-9][A-Z0-9\s/&()'".:-]{6,}$/.test(line) && line === line.toUpperCase();

/**
 * Cleans text by removing problematic special characters
 */
const cleanText = (text) => {
  if (!text) return text;
  // Remove or replace problematic characters
  return String(text)
    .replace(/& þ/g, "") // Remove special characters
    .replace(/Ø=ÜÄ/g, "") // Remove special characters
    .replace(/!'/g, " → ") // Replace arrow-like characters
    .replace(/!"/g, " ↓ ") // Replace arrow-like characters
    .replace(/!`/g, " → ") // Replace arrow-like characters
    .replace(/!'/g, " → ") // Replace arrow-like characters
    .replace(/[^\x20-\x7E\u00A0-\uFFFF]/g, ""); // Remove non-printable characters except common unicode
};

/**
 * Renders text with inline markdown bold formatting (**text**)
 * Uses a simpler approach: process line and render with proper fonts
 */
const renderTextWithBold = (doc, text, options = {}) => {
  const { width, lineGap = 2, indent = 0 } = options;
  const fontSize = doc._fontSize || 11;
  
  // Clean text first
  let cleanTextValue = cleanText(text);
  
  // Check if text contains bold markers
  if (!cleanTextValue.includes("**")) {
    // No bold formatting, render normally
    doc.text(cleanTextValue, { width, lineGap, indent });
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
      doc.font("Helvetica-Bold").fontSize(fontSize);
    } else {
      doc.font("Helvetica").fontSize(fontSize);
    }

    // Render segment - let PDFKit handle wrapping
    // Only add lineGap on the last segment
    doc.text(segment.text, {
      width: width,
      lineGap: index === segments.length - 1 ? lineGap : 0,
      indent: index === 0 ? indent : 0, // Only indent first segment
    });
  });

  // Reset to normal font
  doc.font("Helvetica").fontSize(fontSize);
};

const renderStyledReport = (doc, text, metrics = {}) => {
  const lines = String(text || "").split(/\r?\n/);

  doc.font("Helvetica").fontSize(11);
  doc.fillColor("#111111");

  // Calculate available width for text (page width minus margins)
  const availableWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  let skipUntilNextSection = false;
  let foundMetricsInterpretation = false;
  let inMetricsGaugeSection = false;

  for (let i = 0; i < lines.length; i++) {
    const rawLine = lines[i];
    const line = rawLine.trimEnd();

    // Check if we've found the METRICS GAUGE section
    if (/##\s+METRICS\s+GAUGE/i.test(line) || /METRICS\s+GAUGE/i.test(line)) {
      inMetricsGaugeSection = true;
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(14).text("METRICS GAUGE (Current Snapshot)", {
        width: availableWidth,
        lineGap: 2,
      });
      doc.moveDown(0.3);
      
      // Helper to draw a visual gauge bar using rectangles (more reliable than Unicode)
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
            .fillColor("#FFFFFF")
            .strokeColor("#CCCCCC")
            .lineWidth(0.5)
            .fillAndStroke();
          currentX += blockWidth + blockGap;
        }
        
        // Restore fill color for text
        doc.fillColor(savedFillColor || "#111111");
        
        return currentX; // Return the end X position
      };
      
      // Helper to render a single line metric with proper spacing
      const renderMetricLine = (label, value, isPercentage = true) => {
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
        
        const displayValue = Number(value);
        // For gauge visualization: convert to percentage
        // For Consciousness Level (0-5), convert to percentage for visual bar
        const percentageForGauge = isPercentage ? displayValue : (displayValue / 5) * 100;
        // For display text: show percentage for percentage metrics, raw value for Consciousness Level
        const valueText = isPercentage ? `${Math.round(displayValue)}%` : `${displayValue}`;
        
        // Draw gauge bar
        drawGaugeBar(doc, gaugeStartX, gaugeStartY, percentageForGauge);
        
        // Draw value text (percentage) - on the same line
        doc.font("Helvetica").fontSize(11).fillColor("#111111");
        doc.text(valueText, valueStartX, currentY, {
          width: 80, // Fixed width for percentage text area
          align: "left",
          lineGap: 0,
        });
        
        // Move to next line for next metric
        doc.moveDown(0.2);
      };
      
      console.log("[diagnosticPdf] Rendering METRICS GAUGE with metrics:", metrics);
      
      // Render all metrics with minimal spacing (spacing is handled inside renderMetricLine)
      renderMetricLine("QGC Activation:", metrics.qgcActivation, true);
      renderMetricLine("Consciousness Level:", metrics.consciousnessLevel, false);
      renderMetricLine("Gravity (Load):", metrics.gravity, true);
      renderMetricLine("Signal Coherence:", metrics.signalCoherence, true);
      renderMetricLine("Signal Output:", metrics.signalOutput, true);
      
      // Small spacing after the metrics section
      doc.moveDown(0.3);
      
      continue;
    }
    
    // Skip lines in METRICS GAUGE section until we hit the next section
    if (inMetricsGaugeSection) {
      if (
        (!line.trim() && i + 1 < lines.length && 
         (isAllCapsHeader(lines[i + 1]?.trim()) || 
          lines[i + 1]?.trim().startsWith("SECTION") ||
          lines[i + 1]?.trim().startsWith("PHASE") ||
          lines[i + 1]?.trim().startsWith("##") ||
          lines[i + 1]?.trim() === "----------------------------------------")) ||
        line === "----------------------------------------" ||
        /^SECTION\s+\d+\s+—\s+/.test(line) ||
        /^PHASE\s+\d+\s+—\s+/.test(line) ||
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
      foundMetricsInterpretation = true;
      skipUntilNextSection = true;
      doc.moveDown(0.5);
      doc.font("Helvetica-Bold").fontSize(12).text("METRICS INTERPRETATION TABLE", {
        width: availableWidth,
        lineGap: 2,
      });
      doc.moveDown(0.3);
      drawMetricsInterpretationTable(doc);
      // Reset document position to left margin after drawing table
      doc.x = doc.page.margins.left;
      doc.font("Helvetica").fontSize(11); // Reset font
      continue;
    }

    // Skip lines until we hit the next major section (empty line + header, divider, or section marker)
    if (skipUntilNextSection) {
      // Check if we've hit a new section (empty line followed by header, or divider, or section marker)
      if (
        (!line.trim() && i + 1 < lines.length && 
         (isAllCapsHeader(lines[i + 1]?.trim()) || 
          lines[i + 1]?.trim().startsWith("SECTION") ||
          lines[i + 1]?.trim().startsWith("PHASE") ||
          lines[i + 1]?.trim().startsWith("##") ||
          lines[i + 1]?.trim() === "----------------------------------------")) ||
        line === "----------------------------------------" ||
        /^SECTION\s+\d+\s+—\s+/.test(line) ||
        /^PHASE\s+\d+\s+—\s+/.test(line) ||
        /^##\s+/.test(line) ||
        (isAllCapsHeader(line) && line !== "METRICS INTERPRETATION TABLE")
      ) {
        skipUntilNextSection = false;
        // Reset document position to left margin before processing next section
        doc.x = doc.page.margins.left;
        // Continue processing this line
      } else {
        // Skip this line (it's part of the table text we're replacing)
        continue;
      }
    }

    // Always ensure x position is at left margin before processing any line
    doc.x = doc.page.margins.left;

    if (!line.trim()) {
      doc.moveDown(0.8);
      continue;
    }

    // Markdown horizontal rules (---)
    if (/^---+$/.test(line)) {
      doc.moveDown(0.3);
      continue;
    }

    if (line === "----------------------------------------") {
      drawDivider(doc);
      continue;
    }

    // H1: "* ..."
    if (line.startsWith("* ")) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(16).text(line.slice(2), {
        width: availableWidth,
        lineGap: 2,
      });
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.4);
      continue;
    }

    // Markdown headers (##, ###, etc.)
    if (/^#{1,6}\s+/.test(line)) {
      const headerText = line.replace(/^#{1,6}\s+/, "").trim();
      const headerLevel = (line.match(/^#+/)?.[0] || "").length;
      const fontSize = headerLevel === 1 ? 16 : headerLevel === 2 ? 14 : headerLevel === 3 ? 13 : 12;
      doc.moveDown(0.3);
      doc.font("Helvetica-Bold").fontSize(fontSize).text(headerText, {
        width: availableWidth,
        lineGap: 2,
      });
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.2);
      continue;
    }

    // Section headers
    if (/^SECTION\s+\d+\s+—\s+/.test(line)) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(13).text(line, {
        width: availableWidth,
        lineGap: 2,
      });
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.2);
      continue;
    }

    // Phase headers
    if (/^PHASE\s+\d+\s+—\s+/.test(line)) {
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(12).text(line, {
        width: availableWidth,
        lineGap: 2,
      });
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.2);
      continue;
    }

    // Block headers
    if (line === "EVIDENCE:") {
      doc.font("Helvetica-Bold").fontSize(11).text(line, {
        width: availableWidth,
        lineGap: 2,
      });
      doc.font("Helvetica").fontSize(11);
      continue;
    }

    if (isAllCapsHeader(line)) {
      // Reset x position to left margin for headers
      doc.x = doc.page.margins.left;
      doc.moveDown(0.2);
      doc.font("Helvetica-Bold").fontSize(12).text(line, {
        width: availableWidth,
        lineGap: 2,
      });
      doc.font("Helvetica").fontSize(11);
      doc.moveDown(0.1);
      continue;
    }

    // Bullets: "- ..." or "• ..."
    if (/^[\-\•]\s+/.test(line)) {
      const bulletText = line.replace(/^[\-\•]\s+/, "").trim();
      // Clean the text and render with bold support
      const cleanBulletText = cleanText(bulletText);
      renderTextWithBold(doc, `• ${cleanBulletText}`, {
        width: availableWidth,
        indent: 18,
        lineGap: 2,
      });
      continue;
    }

    // Body - clean text first, then render with inline bold formatting support
    const cleanedLine = cleanText(line);
    renderTextWithBold(doc, cleanedLine, {
      width: availableWidth,
      lineGap: 2,
    });
  }
};

/**
 * Extract week number from title, handling "Week One", "Week 12", "Week Seven (B)" etc.
 */
const extractWeekFromTitle = (title) => {
  if (!title) return null;
  
  const titleLower = title.toLowerCase();
  
  // Handle "Week Seven (B)" or "Week 7 (B)" -> "7B"
  if (titleLower.includes("week seven (b)") || titleLower.includes("week 7 (b)") || 
      (titleLower.includes("week seven") && titleLower.includes("(b)"))) {
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
    one: 1, two: 2, three: 3, four: 4, five: 5, six: 6,
    seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12
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
    const { getCourseWithModulesAndLessons, extractVideosFromCourse } = await import("../controllers/kajabi.js");
    const courseData = await getCourseWithModulesAndLessons(courseId);
    const videos = extractVideosFromCourse(courseData);
    
    // Build mapping: week number -> video title
    const weekToTitle = {};
    videos.forEach((video) => {
      const week = extractWeekFromTitle(video.title);
      if (week && !weekToTitle[week]) {
        // Prefer "Live & Journey" videos, but fallback to any week video
        if (video.title.toLowerCase().includes("live & journey") || !weekToTitle[week]) {
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
const generateUnlimitedCreatedRecommendations = async (metrics = {}, aiReport = {}, weekTitles = {}) => {
  const gravity = metrics.gravity || 0;
  const signalOutput = metrics.signalOutput || 0;
  const signalCoherence = metrics.signalCoherence || 0;
  const consciousnessLevel = metrics.consciousnessLevel || 0;
  const qgcActivation = metrics.qgcActivation || 0;

  // Extract structure type and vortex status from report if available
  const reportText = typeof aiReport === "string" ? aiReport : JSON.stringify(aiReport);
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
    if (hasHighGravity || (reportText && /fear|anxiety|worry/i.test(reportText))) {
      recommendations.phase1.push({ week: 4, title: getWeekTitle(4) });
    }

    // Week 6 — Lineage Rules (for lineage patterns or inherited structures)
    if (reportText && /lineage|father|mother|grandfather|family|inherited/i.test(reportText)) {
      recommendations.phase1.push({ week: 6, title: getWeekTitle(6) });
    }

    // Week 7B — Visibility, Witch Lineage, Power Safety (for visibility issues or power safety)
    if (
      hasLowSignalOutput ||
      (reportText && /visibility|invisible|witch|power.*safety|safety.*power/i.test(reportText))
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
  if (hasLowCL || hasLowQGC || (reportText && /identity|structure.*type|sovereignty/i.test(reportText))) {
    // Week 2 — Rising Out of Environment (for environment/sovereignty issues)
    if (hasLowCL || (reportText && /environment|sovereignty|rising/i.test(reportText))) {
      recommendations.phase2.push({ week: 2, title: getWeekTitle(2) });
    }

    // Week 3 — Identity as Creator (for identity/creator embodiment)
    if (hasLowQGC || (reportText && /creator|identity|embodiment|code.*holder/i.test(reportText))) {
      recommendations.phase2.push({ week: 3, title: getWeekTitle(3) });
    }
  }

  // PHASE 3 — Prosperity & Leadership
  // Recommended when: Signal output is improving, CL is higher, or prosperity/leadership themes
  if (
    signalOutput >= 30 ||
    consciousnessLevel >= 2.5 ||
    (reportText && /prosperity|money|leadership|timeline|integration/i.test(reportText))
  ) {
    // Week 9 — Merging Timelines (for timeline work or integration)
    if (reportText && /timeline|past.*present|future|merging/i.test(reportText)) {
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
    if (consciousnessLevel >= 3.0 || (reportText && /higher.*octave|identity.*flip/i.test(reportText))) {
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
  const sectionWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
  
  doc.moveDown(1);
  doc.font("Helvetica-Bold").fontSize(14).text("UNLIMITED CREATED RECOMMENDATIONS", {
    width: sectionWidth,
    lineGap: 2,
  });
  doc.moveDown(0.5);

  // PHASE 1
  if (recommendations.phase1.length > 0) {
    doc.font("Helvetica-Bold").fontSize(12).text("PHASE 1 — Remove Gravity & Interference", {
      width: sectionWidth,
      lineGap: 2,
    });
    doc.moveDown(0.3);
    recommendations.phase1.forEach((rec) => {
      doc.font("Helvetica").fontSize(11).text(`● Week ${rec.week} — ${rec.title}`, {
        width: sectionWidth,
        lineGap: 1.5,
        indent: 10,
      });
    });
    doc.moveDown(0.4);
  }

  // PHASE 2
  if (recommendations.phase2.length > 0) {
    doc.font("Helvetica-Bold").fontSize(12).text("PHASE 2 — Stabilise Identity", {
      width: sectionWidth,
      lineGap: 2,
    });
    doc.moveDown(0.3);
    recommendations.phase2.forEach((rec) => {
      doc.font("Helvetica").fontSize(11).text(`● Week ${rec.week} — ${rec.title}`, {
        width: sectionWidth,
        lineGap: 1.5,
        indent: 10,
      });
    });
    doc.moveDown(0.4);
  }

  // PHASE 3
  if (recommendations.phase3.length > 0) {
    doc.font("Helvetica-Bold").fontSize(12).text("PHASE 3 — Prosperity & Leadership", {
      width: sectionWidth,
      lineGap: 2,
    });
    doc.moveDown(0.3);
    recommendations.phase3.forEach((rec) => {
      doc.font("Helvetica").fontSize(11).text(`● Week ${rec.week} — ${rec.title}`, {
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
      const outputDir = path.join(
        __dirname,
        "..",
        "..",
        "reports",
        "diagnostics"
      );
      ensureDir(outputDir);

      const filePath = path.join(
        outputDir,
        `diagnostic-${diagnostic.id || Date.now()}.pdf`
      );

      const doc = new PDFDocument({ margin: 50 });
      const stream = fs.createWriteStream(filePath);

      stream.on("finish", () => resolve(filePath));
      stream.on("error", reject);

      doc.pipe(stream);

      const data = diagnostic.data || {};
      const profile = data.profile || {};
      const aiReport = data.aiReport || {};
      let metrics = data.metrics || {};

      // If metrics are empty or incomplete, try to extract from report text
      const hasAllMetrics = metrics.gravity !== undefined && 
                            metrics.signalCoherence !== undefined && 
                            metrics.signalOutput !== undefined &&
                            metrics.consciousnessLevel !== undefined &&
                            metrics.qgcActivation !== undefined;
      
      if (typeof aiReport === "string" && !hasAllMetrics) {
        const { extractMetricsFromReport } = require("../helpers/euphoriamChatbot");
        const extractedMetrics = extractMetricsFromReport(aiReport);
        // Merge extracted metrics, preferring existing metrics over extracted ones
        metrics = {
          ...extractedMetrics,
          ...metrics, // Existing metrics take precedence
          // But use extracted if existing is undefined
          gravity: metrics.gravity ?? extractedMetrics.gravity,
          signalCoherence: metrics.signalCoherence ?? extractedMetrics.signalCoherence,
          signalOutput: metrics.signalOutput ?? extractedMetrics.signalOutput,
          consciousnessLevel: metrics.consciousnessLevel ?? extractedMetrics.consciousnessLevel,
          qgcActivation: metrics.qgcActivation ?? extractedMetrics.qgcActivation,
        };
        console.log("[diagnosticPdf] Metrics after extraction:", metrics);
      }

      if (typeof aiReport === "string") {
        console.log("[diagnosticPdf] aiReport typeof:", typeof aiReport);
        console.log("[diagnosticPdf] aiReport head:", aiReport.slice(0, 200));
        console.log("[diagnosticPdf] Metrics for PDF:", metrics);

        // Allow: legacy divider-led reports, intro-led reports, or title pages
        // that contain the intro within the first chunk.
        const trimmed = aiReport.trimStart();
        const startsWithDivider = trimmed.startsWith(
          "----------------------------------------"
        );
        const startsWithIntro = trimmed.startsWith(
          "✨ BEFORE YOU READ THIS DIAGNOSTIC"
        );
        const containsIntroEarly =
          !startsWithIntro &&
          trimmed.slice(0, 500).includes("BEFORE YOU READ THIS DIAGNOSTIC");
        const startsWithTitle = trimmed
          .toUpperCase()
          .startsWith("EUPHORIAM DIAGNOSTIC REPORT");
        const startsWithFullTitle = /^EUPHORIAM.*DIAGNOSTIC REPORT/i.test(
          trimmed
        );
        // Check for markdown format (--- followed by ## header, or just ## header)
        const hasMarkdownHeader = /^---+[\s\n]*##\s*EUPHORIAM.*STRUCTURAL UPDATE REPORT/i.test(
          trimmed
        ) || /^##\s*EUPHORIAM.*STRUCTURAL UPDATE REPORT/i.test(trimmed);
        const startsWithMarkdownHeader = /^#+\s*EUPHORIAM/i.test(trimmed);
        const startsWithMarkdownDivider = /^---+/.test(trimmed);

        if (
          !startsWithDivider &&
          !startsWithIntro &&
          !containsIntroEarly &&
          !startsWithTitle &&
          !startsWithFullTitle &&
          !hasMarkdownHeader &&
          !startsWithMarkdownHeader &&
          !startsWithMarkdownDivider
        ) {
          const head = aiReport.slice(0, 300);
          const err = new Error(
            `aiReport does not start with a recognized header. First 300 chars:\n${head}`
          );
          err.code = "AI_REPORT_TEMPLATE_MISMATCH";
          throw err;
        }

        renderStyledReport(doc, aiReport, metrics);

        // Add Unlimited Created week-wise recommendations after the report
        // Fetch course videos to get actual titles
        const weekTitles = await fetchCourseWeekTitles("2148785745").catch(() => ({}));
        const ucRecommendations = await generateUnlimitedCreatedRecommendations(metrics, aiReport, weekTitles);
        if (
          ucRecommendations.phase1.length > 0 ||
          ucRecommendations.phase2.length > 0 ||
          ucRecommendations.phase3.length > 0
        ) {
          renderUnlimitedCreatedRecommendations(doc, ucRecommendations);
        }

        // Optional metadata on a new page (after the report)
        doc.addPage();
        const metadataWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
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
          }
        );
        doc.text(`User ID: ${diagnostic.userId || "N/A"}`, {
          width: metadataWidth,
          lineGap: 2,
        });
        doc.moveDown(0.6);
        doc.text(`Customer ID: ${data.customerId || "N/A"}`, {
          width: metadataWidth,
          lineGap: 2,
        });
        doc.text(`Site ID: ${data.siteId || "N/A"}`, {
          width: metadataWidth,
          lineGap: 2,
        });
        doc.text(
          `Kajabi Contact ID: ${data.rawSource?.kajabiContactId ?? "N/A"}`,
          {
            width: metadataWidth,
            lineGap: 2,
          }
        );
        doc.text(
          `Kajabi Customer ID: ${data.rawSource?.kajabiCustomerId ?? "N/A"}`,
          {
            width: metadataWidth,
            lineGap: 2,
          }
        );

        doc.end();
        return;
      }

      const reportTitle =
        aiReport?.headline?.title ||
        aiReport?.headline ||
        "Euphoriam Diagnostic Report";
      const titleWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;
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
      doc.text(`User ID: ${diagnostic.userId || "N/A"}`, {
        width: titleWidth,
        lineGap: 2,
      });

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
          ].filter(Boolean)
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
          ].filter(Boolean)
        );

        const products = facts.products || data.products || [];
        addSection(
          doc,
          "Products / Access",
          (products || []).map((p) => {
            const title = p.title || p.id || "Product";
            const type = p.type ? ` (${p.type})` : "";
            return `${title}${type}`;
          })
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
          })
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
        doc.font("Helvetica-Bold").fontSize(12).text("METRICS INTERPRETATION TABLE");
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
            Array.isArray(s.evidence) ? s.evidence.map((e) => `- ${e}`) : []
          );
        }

        const rec = aiReport.recommendationEngine || {};
        const phases = Array.isArray(rec.phases) ? rec.phases : [];
        for (const p of phases) {
          addList(doc, p.title || "Recommendation Phase", p.items || []);
        }

        // Add Unlimited Created week-wise recommendations
        // Fetch course videos to get actual titles
        const weekTitles = await fetchCourseWeekTitles("2148785745").catch(() => ({}));
        const ucRecommendations = await generateUnlimitedCreatedRecommendations(metrics, aiReport, weekTitles);
        renderUnlimitedCreatedRecommendations(doc, ucRecommendations);

        const finalSummary = aiReport.finalSummary || {};
        addList(
          doc,
          finalSummary.title || "Final Summary",
          finalSummary.bullets || []
        );
      }

      addSection(
        doc,
        "Products",
        (data.products || []).map((p) => {
          const title = p.title || p.id || "Product";
          const type = p.type ? ` (${p.type})` : "";
          return `${title}${type}`;
        })
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
          })
        );
      }

      addSection(doc, "Raw Source", [
        `Customer ID: ${data.customerId || "N/A"}`,
        `Kajabi Contact ID: ${data.rawSource?.kajabiContactId ?? "N/A"}`,
        `Site ID: ${data.siteId || "N/A"}`,
      ]);

      doc.end();
    } catch (err) {
      reject(err);
    }
  });

module.exports = { generateDiagnosticPdf };
