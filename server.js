const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STAFF_API_KEY = process.env.STAFF_API_KEY || "staff123";

let reports = [];

app.get("/", (req, res) => {
  res.send("Rave Safety backend is running.");
});

app.get("/reports", (req, res) => {
  const apiKey = req.headers["x-staff-key"];

  if (apiKey !== STAFF_API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  res.json({
    success: true,
    reports
  });
});

app.patch("/reports/:id/status", async (req, res) => {
  const apiKey = req.headers["x-staff-key"];

  if (apiKey !== STAFF_API_KEY) {
    return res.status(401).json({
      success: false,
      error: "Unauthorized"
    });
  }

  const { id } = req.params;
  const { status } = req.body;

  const allowedStatuses = ["open", "in_progress", "resolved"];

  if (!allowedStatuses.includes(status)) {
    return res.status(400).json({
      success: false,
      error: "Invalid status"
    });
  }

  const reportIndex = reports.findIndex(report => report.id === id);

  if (reportIndex === -1) {
    return res.status(404).json({
      success: false,
      error: "Report not found"
    });
  }

  reports[reportIndex].status = status;

  try {
    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text:
`🛠️ Incident Status Updated

Incident: ${reports[reportIndex].incidentType}
New Status: ${status}
Report ID: ${id}`
      }
    );
  } catch (error) {
    console.error("Failed to notify Telegram about status update");
  }

  res.json({
    success: true,
    report: reports[reportIndex]
  });
});

app.post("/report", async (req, res) => {
  let tempFilePath = null;

  try {
    const {
      incidentType,
      description,
      location,
      isAnonymous,
      timestamp,
      latitude,
      longitude,
      isEmergency,
      photoBase64
    } = req.body;

    const reportId = Date.now().toString();

    const newReport = {
      id: reportId,
      incidentType,
      description,
      location,
      isAnonymous,
      timestamp,
      latitude,
      longitude,
      isEmergency,
      hasPhoto: !!photoBase64,
      status: "open"
    };

    reports.unshift(newReport);

    if (reports.length > 200) {
      reports = reports.slice(0, 200);
    }

    const gpsLink =
      latitude != null && longitude != null
        ? `https://maps.google.com/?q=${latitude},${longitude}`
        : "Not available";

    const message = isEmergency
      ? `🚨🚨🚨 EMERGENCY ALERT 🚨🚨🚨

NEEDS IMMEDIATE ATTENTION

Incident: ${incidentType}
Location: ${location || "Not provided"}
Description: ${description}
Anonymous: ${isAnonymous ? "Yes" : "No"}
Time: ${timestamp}

📍 Live Map:
${gpsLink}`
      : `⚠️ New Safety Report

Incident: ${incidentType}
Location: ${location || "Not provided"}
Description: ${description}
Anonymous: ${isAnonymous ? "Yes" : "No"}
Time: ${timestamp}

📍 Map Location:
${gpsLink}`;

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      }
    );

    if (photoBase64) {
      const imageBuffer = Buffer.from(photoBase64, "base64");
      tempFilePath = path.join(__dirname, `incident_${Date.now()}.jpg`);

      fs.writeFileSync(tempFilePath, imageBuffer);

      const form = new FormData();
      form.append("chat_id", TELEGRAM_CHAT_ID);
      form.append("photo", fs.createReadStream(tempFilePath));
      form.append(
        "caption",
        isEmergency ? "🚨 Emergency Incident Photo" : "📸 Incident Photo"
      );

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
        form,
        {
          headers: form.getHeaders(),
          maxContentLength: Infinity,
          maxBodyLength: Infinity
        }
      );
    }

    res.json({
      success: true
    });
  } catch (error) {
    console.error("=== TELEGRAM ERROR ===");

    if (error.response) {
      console.error("Status:", error.response.status);
      console.error("Data:", error.response.data);
    } else {
      console.error(error.message);
    }

    res.status(500).json({
      success: false,
      error: "Failed to send report to Telegram"
    });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, "0.0.0.0", () => {
  console.log(`Server running on port ${PORT}`);
});