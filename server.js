const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const admin = require("firebase-admin");

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const STAFF_API_KEY = process.env.STAFF_API_KEY || "staff123";

const firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

admin.initializeApp({
  credential: admin.credential.cert(firebaseServiceAccount)
});

let reports = [];
let staffDevices = [];

let reportCounters = {
  MED: 1,
  HAR: 1,
  SEC: 1,
  THE: 1,
  SUS: 1,
  GEN: 1
};

function getIncidentPrefix(type) {

  switch (type) {

    case "Medical Emergency":
      return "MED";

    case "Harassment":
      return "HAR";

    case "Violence":
      return "SEC";

    case "Theft":
      return "THE";

    case "Suspicious Activity":
      return "SUS";

    default:
      return "GEN";
  }
}

app.get("/", (req, res) => {
  res.send("Rave Safety backend running");
});

app.post("/staff/register-device", (req, res) => {

  const apiKey = req.headers["x-staff-key"];

  if (apiKey !== STAFF_API_KEY) {
    return res.status(401).json({ success: false });
  }

  const { fcmToken } = req.body;

  if (!fcmToken) {
    return res.status(400).json({ success: false });
  }

  const exists = staffDevices.find(d => d.fcmToken === fcmToken);

  if (!exists) {

    staffDevices.push({
      fcmToken,
      registeredAt: new Date().toISOString()
    });

  }

  res.json({ success: true });
});

app.get("/reports", (req, res) => {

  const apiKey = req.headers["x-staff-key"];

  if (apiKey !== STAFF_API_KEY) {
    return res.status(401).json({ success: false });
  }

  res.json({
    success: true,
    reports
  });
});

app.get("/report-status/:id", (req, res) => {

  const { id } = req.params;

  const report = reports.find(r => r.id === id);

  if (!report) {
    return res.status(404).json({ success: false });
  }

  res.json({
    success: true,
    report: {
      id: report.id,
      incidentType: report.incidentType,
      status: report.status,
      location: report.location,
      timestamp: report.timestamp,
      isEmergency: report.isEmergency
    }
  });
});

app.patch("/reports/:id/status", (req, res) => {

  const apiKey = req.headers["x-staff-key"];

  if (apiKey !== STAFF_API_KEY) {
    return res.status(401).json({ success: false });
  }

  const { id } = req.params;
  const { status } = req.body;

  const reportIndex = reports.findIndex(r => r.id === id);

  if (reportIndex === -1) {
    return res.status(404).json({ success: false });
  }

  reports[reportIndex].status = status;

  res.json({
    success: true,
    report: reports[reportIndex]
  });
});

app.post("/report", async (req, res) => {

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
      photoBase64,
      reporterName,
      reporterPhone,
      reporterInstagram,
      contactNote
    } = req.body;

    const prefix = getIncidentPrefix(incidentType);

    const number = reportCounters[prefix];

    const reportId = prefix + String(number).padStart(3, "0");

    reportCounters[prefix]++;

    const report = {
      id: reportId,
      incidentType,
      description,
      location,
      isAnonymous,
      timestamp,
      latitude,
      longitude,
      isEmergency,
      status: "open",
      hasPhoto: !!photoBase64,
      reporterName,
      reporterPhone,
      reporterInstagram,
      contactNote
    };

    reports.unshift(report);

    const gpsLink =
      latitude != null && longitude != null
        ? `https://maps.google.com/?q=${latitude},${longitude}`
        : "Location unavailable";

    const contactInfo = isAnonymous
      ? "Reporter: Anonymous"
      : `Reporter: ${reporterName || "Not provided"}
Phone: ${reporterPhone || "Not provided"}
Instagram: ${reporterInstagram || "Not provided"}
Note: ${contactNote || "None"}`;

    const message = isEmergency
      ? `🚨 EMERGENCY ALERT

Incident: ${incidentType}
Location: ${location}
Description: ${description}

${contactInfo}

Report ID: ${reportId}

Map:
${gpsLink}`
      : `⚠️ Safety Report

Incident: ${incidentType}
Location: ${location}
Description: ${description}

${contactInfo}

Report ID: ${reportId}

Map:
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

      const tempFile = path.join(__dirname, `photo_${Date.now()}.jpg`);

      fs.writeFileSync(tempFile, imageBuffer);

      const form = new FormData();
      form.append("chat_id", TELEGRAM_CHAT_ID);
      form.append("photo", fs.createReadStream(tempFile));

      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendPhoto`,
        form,
        {
          headers: form.getHeaders()
        }
      );

      fs.unlinkSync(tempFile);
    }

    for (const device of staffDevices) {

      try {

        await admin.messaging().send({
          token: device.fcmToken,
          notification: {
            title: isEmergency ? "🚨 Emergency Alert" : "⚠️ New Report",
            body: `${incidentType} - ${location}`
          },
          data: {
            reportId
          }
        });

      } catch (error) {
        console.log("Push failed");
      }
    }

    res.json({
      success: true,
      reportId
    });

  } catch (error) {

    console.log(error);

    res.status(500).json({
      success: false
    });

  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
  console.log("Server running on port " + PORT);
});