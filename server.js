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

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseServiceAccount)
  });
}

const db = admin.firestore();

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

async function verifyAdminAccess(req) {
  try {
    const uid = req.headers["x-staff-uid"];

    if (!uid) {
      return { ok: false, status: 401, error: "Missing staff uid" };
    }

    const staffDoc = await db.collection("staffUsers").doc(uid).get();

    if (!staffDoc.exists) {
      return { ok: false, status: 403, error: "Staff profile not found" };
    }

    const data = staffDoc.data() || {};

    if (!data.active) {
      return { ok: false, status: 403, error: "Staff account inactive" };
    }

    if (!data.canManageStaff) {
      return { ok: false, status: 403, error: "No permission to manage staff" };
    }

    return { ok: true, uid, profile: data };
  } catch (error) {
    console.error("verifyAdminAccess error:", error);
    return { ok: false, status: 500, error: "Failed to verify admin access" };
  }
}

app.get("/", (req, res) => {
  res.send("Rave Safety backend running");
});

app.post("/staff/register-device", (req, res) => {
  try {
    const apiKey = req.headers["x-staff-key"];

    if (apiKey !== STAFF_API_KEY) {
      return res.status(401).json({
        success: false,
        error: "Unauthorized"
      });
    }

    const { fcmToken, platform } = req.body;

    if (!fcmToken) {
      return res.status(400).json({
        success: false,
        error: "Missing token"
      });
    }

    const exists = staffDevices.find(d => d.fcmToken === fcmToken);

    if (!exists) {
      staffDevices.push({
        fcmToken,
        platform: platform || "ios",
        registeredAt: new Date().toISOString()
      });
    }

    res.json({
      success: true,
      devicesCount: staffDevices.length
    });
  } catch (error) {
    console.error("register-device error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to register device"
    });
  }
});

app.get("/reports", (req, res) => {
  try {
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
  } catch (error) {
    console.error("get reports error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to load reports"
    });
  }
});

app.get("/report-status/:id", (req, res) => {
  try {
    const { id } = req.params;

    const report = reports.find(r => r.id === id);

    if (!report) {
      return res.status(404).json({
        success: false,
        error: "Report not found"
      });
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
  } catch (error) {
    console.error("report-status error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to load report status"
    });
  }
});

app.patch("/reports/:id/status", async (req, res) => {
  try {
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

    const reportIndex = reports.findIndex(r => r.id === id);

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
    } catch (telegramError) {
      console.error("Telegram status update error:", telegramError.response?.data || telegramError.message);
    }

    res.json({
      success: true,
      report: reports[reportIndex]
    });
  } catch (error) {
    console.error("patch report status error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update report status"
    });
  }
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
      photoBase64,
      isMedicalHelp,
      consciousStatus,
      breathingStatus,
      approximateAge,
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
      incidentType: incidentType || "Other",
      description: description || "",
      location: location || "",
      isAnonymous: !!isAnonymous,
      timestamp: timestamp || new Date().toISOString(),
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      isEmergency: !!isEmergency,
      status: "open",
      hasPhoto: !!photoBase64,
      isMedicalHelp: !!isMedicalHelp,
      consciousStatus: consciousStatus || null,
      breathingStatus: breathingStatus || null,
      approximateAge: approximateAge || null,
      reporterName: isAnonymous ? null : (reporterName || null),
      reporterPhone: isAnonymous ? null : (reporterPhone || null),
      reporterInstagram: isAnonymous ? null : (reporterInstagram || null),
      contactNote: isAnonymous ? null : (contactNote || null)
    };

    reports.unshift(report);

    if (reports.length > 500) {
      reports = reports.slice(0, 500);
    }

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

    const medicalInfo = isMedicalHelp
      ? `Medical Help: Yes
Conscious: ${consciousStatus || "Not provided"}
Breathing Normally: ${breathingStatus || "Not provided"}
Approximate Age: ${approximateAge || "Not provided"}`
      : "Medical Help: No";

    const message = isEmergency
      ? `🚨 EMERGENCY ALERT

Incident: ${incidentType || "Other"}
Location: ${location || "Not provided"}
Description: ${description || "Not provided"}

${contactInfo}

${medicalInfo}

Report ID: ${reportId}

Map:
${gpsLink}`
      : `⚠️ Safety Report

Incident: ${incidentType || "Other"}
Location: ${location || "Not provided"}
Description: ${description || "Not provided"}

${contactInfo}

${medicalInfo}

Report ID: ${reportId}

Map:
${gpsLink}`;

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.error("Missing Telegram env vars");
      return res.status(500).json({
        success: false,
        error: "Telegram environment variables missing"
      });
    }

    await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
      {
        chat_id: TELEGRAM_CHAT_ID,
        text: message
      }
    );

    if (photoBase64) {
      const imageBuffer = Buffer.from(photoBase64, "base64");
      tempFilePath = path.join(__dirname, `photo_${Date.now()}.jpg`);

      fs.writeFileSync(tempFilePath, imageBuffer);

      const form = new FormData();
      form.append("chat_id", TELEGRAM_CHAT_ID);
      form.append("photo", fs.createReadStream(tempFilePath));
      form.append(
        "caption",
        isEmergency
          ? `🚨 Emergency Incident Photo\nReport ID: ${reportId}`
          : `📸 Incident Photo\nReport ID: ${reportId}`
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

    for (const device of staffDevices) {
      try {
        await admin.messaging().send({
          token: device.fcmToken,
          notification: {
            title: isEmergency ? "🚨 Emergency Alert" : "⚠️ New Report",
            body: `${incidentType || "Other"} - ${location || "Unknown location"}`
          },
          data: {
            reportId,
            incidentType: incidentType || "",
            location: location || "",
            timestamp: timestamp || "",
            isEmergency: String(!!isEmergency),
            isAnonymous: String(!!isAnonymous)
          },
          apns: {
            payload: {
              aps: {
                sound: "default"
              }
            }
          }
        });
      } catch (pushError) {
        console.error("Push failed:", pushError.message);
      }
    }

    res.json({
      success: true,
      reportId
    });
  } catch (error) {
    console.error("POST /report error:", error.response?.data || error.message || error);

    res.status(500).json({
      success: false,
      error: "Failed to submit report"
    });
  } finally {
    if (tempFilePath && fs.existsSync(tempFilePath)) {
      fs.unlinkSync(tempFilePath);
    }
  }
});

app.get("/admin/staff-users", async (req, res) => {
  try {
    const access = await verifyAdminAccess(req);

    if (!access.ok) {
      return res.status(access.status).json({
        success: false,
        error: access.error
      });
    }

    const snapshot = await db.collection("staffUsers").get();

    const staffUsers = snapshot.docs.map(doc => {
      const data = doc.data() || {};

      return {
        uid: doc.id,
        name: data.name || "",
        email: data.email || "",
        role: data.role || "staff",
        team: data.team || "general",
        active: data.active ?? false,
        canManageStaff: data.canManageStaff ?? false,
        canEditEventInfo: data.canEditEventInfo ?? false,
        canUseStaffChat: data.canUseStaffChat ?? true,
        canViewAllReports: data.canViewAllReports ?? true
      };
    });

    res.json({
      success: true,
      staffUsers
    });
  } catch (error) {
    console.error("GET /admin/staff-users error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to load staff users"
    });
  }
});

app.post("/admin/create-staff", async (req, res) => {
  try {
    const access = await verifyAdminAccess(req);

    if (!access.ok) {
      return res.status(access.status).json({
        success: false,
        error: access.error
      });
    }

    const {
      name,
      email,
      password,
      role,
      team,
      active,
      canManageStaff,
      canEditEventInfo,
      canUseStaffChat,
      canViewAllReports
    } = req.body;

    if (!name || !email || !password || !role || !team) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields"
      });
    }

    const userRecord = await admin.auth().createUser({
      email,
      password,
      displayName: name
    });

    await db.collection("staffUsers").doc(userRecord.uid).set({
      name,
      email,
      role,
      team,
      active: active ?? true,
      canManageStaff: canManageStaff ?? false,
      canEditEventInfo: canEditEventInfo ?? false,
      canUseStaffChat: canUseStaffChat ?? true,
      canViewAllReports: canViewAllReports ?? true,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      uid: userRecord.uid
    });
  } catch (error) {
    console.error("POST /admin/create-staff error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to create staff"
    });
  }
});

app.patch("/admin/update-staff/:uid", async (req, res) => {
  try {
    const access = await verifyAdminAccess(req);

    if (!access.ok) {
      return res.status(access.status).json({
        success: false,
        error: access.error
      });
    }

    const { uid } = req.params;

    const {
      name,
      role,
      team,
      active,
      canManageStaff,
      canEditEventInfo,
      canUseStaffChat,
      canViewAllReports
    } = req.body;

    const updates = {};

    if (name !== undefined) updates.name = name;
    if (role !== undefined) updates.role = role;
    if (team !== undefined) updates.team = team;
    if (active !== undefined) updates.active = active;
    if (canManageStaff !== undefined) updates.canManageStaff = canManageStaff;
    if (canEditEventInfo !== undefined) updates.canEditEventInfo = canEditEventInfo;
    if (canUseStaffChat !== undefined) updates.canUseStaffChat = canUseStaffChat;
    if (canViewAllReports !== undefined) updates.canViewAllReports = canViewAllReports;

    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await db.collection("staffUsers").doc(uid).update(updates);

    if (name !== undefined) {
      await admin.auth().updateUser(uid, {
        displayName: name
      });
    }

    res.json({
      success: true
    });
  } catch (error) {
    console.error("PATCH /admin/update-staff error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to update staff"
    });
  }
});

app.patch("/admin/toggle-staff/:uid", async (req, res) => {
  try {
    const access = await verifyAdminAccess(req);

    if (!access.ok) {
      return res.status(access.status).json({
        success: false,
        error: access.error
      });
    }

    const { uid } = req.params;
    const { active } = req.body;

    await db.collection("staffUsers").doc(uid).update({
      active,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true
    });
  } catch (error) {
    console.error("PATCH /admin/toggle-staff error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to toggle staff"
    });
  }
});

const PORT = process.env.PORT || 3000;

app.listen(PORT, "0.0.0.0", () => {
  console.log("Server running on port " + PORT);
});