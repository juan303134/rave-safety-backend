const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs");
const path = require("path");
const FormData = require("form-data");
const admin = require("firebase-admin");
const crypto = require("crypto");
const {
  buildStaffPushMessage,
  getIncidentPrefix,
  hasStaffPermission,
  hasStaffRole,
  isValidClientReportId,
  matchesStaffRole
} = require("./report-utils");

const app = express();

app.use(cors());
app.use(express.json({ limit: "25mb" }));

const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

const firebaseServiceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT_JSON);

if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(firebaseServiceAccount)
  });
}

const db = admin.firestore();

async function createReportOnce(clientReportId, incidentType, reportData) {
  const requestRef = db.collection("reportRequests").doc(clientReportId);
  const prefix = getIncidentPrefix(incidentType);
  const counterRef = db.collection("system").doc(`reportCounter_${prefix}`);

  return db.runTransaction(async (transaction) => {
    const requestDoc = await transaction.get(requestRef);

    if (requestDoc.exists) {
      return {
        reportId: requestDoc.data().reportId,
        deduplicated: true
      };
    }

    const counterDoc = await transaction.get(counterRef);
    const current = counterDoc.exists ? counterDoc.data().value || 0 : 0;
    const next = current + 1;
    const reportId = prefix + String(next).padStart(3, "0");
    const reportRef = db.collection("reports").doc(reportId);

    transaction.set(counterRef, { value: next }, { merge: true });
    transaction.set(reportRef, {
      ...reportData,
      id: reportId,
      clientReportId
    });
    transaction.set(requestRef, {
      reportId,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    return { reportId, deduplicated: false };
  });
}

function normalizeTimestampFields(data) {
  return {
    ...data,
    createdAt: data.createdAt?.toDate ? data.createdAt.toDate().toISOString() : data.createdAt,
    updatedAt: data.updatedAt?.toDate ? data.updatedAt.toDate().toISOString() : data.updatedAt
  };
}

function getBearerToken(req) {
  const authorization = req.get("authorization");

  if (!authorization) {
    return null;
  }

  const [scheme, token] = authorization.trim().split(/\s+/);

  if (scheme?.toLowerCase() !== "bearer" || !token) {
    return null;
  }

  return token;
}

async function authenticateStaff(req, res, next) {
  const token = getBearerToken(req);

  if (!token) {
    return res.status(401).json({
      success: false,
      error: "Missing or invalid authorization token"
    });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(token, true);
    const staffDoc = await db.collection("staffUsers").doc(decodedToken.uid).get();

    if (!staffDoc.exists) {
      return res.status(403).json({
        success: false,
        error: "Staff profile not found"
      });
    }

    const profile = staffDoc.data() || {};

    if (!profile.active) {
      return res.status(403).json({
        success: false,
        error: "Staff account inactive"
      });
    }

    req.staff = {
      uid: decodedToken.uid,
      profile
    };

    return next();
  } catch (error) {
    console.error("authenticateStaff error:", error.code || error.message || error);

    return res.status(401).json({
      success: false,
      error: "Invalid or expired authorization token"
    });
  }
}

function requireStaffPermission(permission) {
  return (req, res, next) => {
    if (!hasStaffPermission(req.staff?.profile, permission)) {
      return res.status(403).json({
        success: false,
        error: `Missing required permission: ${permission}`
      });
    }

    return next();
  };
}

function requireStaffRole(role) {
  return (req, res, next) => {
    if (!hasStaffRole(req.staff?.profile, role)) {
      return res.status(403).json({
        success: false,
        error: `Required staff role: ${role}`
      });
    }

    return next();
  };
}

app.get("/", (req, res) => {
  res.send("Rave Safety backend running");
});

app.get("/health", (req, res) => {
  res.json({
    ok: true,
    telegramBot: !!process.env.TELEGRAM_BOT_TOKEN,
    telegramChat: !!process.env.TELEGRAM_CHAT_ID,
    firebaseJson: !!process.env.FIREBASE_SERVICE_ACCOUNT_JSON
  });
});

app.post("/staff/register-device", authenticateStaff, async (req, res) => {
  try {
    const { fcmToken, platform } = req.body;
    const normalizedToken = typeof fcmToken === "string" ? fcmToken.trim() : "";

    if (!normalizedToken) {
      return res.status(400).json({
        success: false,
        error: "Missing token"
      });
    }

    const deviceID = crypto.createHash("sha256").update(normalizedToken).digest("hex");

    await db.collection("staffDevices").doc(deviceID).set({
      fcmToken: normalizedToken,
      platform: platform === "ios" ? "ios" : "unknown",
      staffUID: req.staff.uid,
      active: true,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    }, { merge: true });

    res.json({
      success: true,
      deviceID
    });
  } catch (error) {
    console.error("register-device error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to register device"
    });
  }
});

app.delete("/staff/register-device", authenticateStaff, async (req, res) => {
  try {
    const normalizedToken = typeof req.body.fcmToken === "string" ? req.body.fcmToken.trim() : "";

    if (!normalizedToken) {
      return res.status(400).json({ success: false, error: "Missing token" });
    }

    const deviceID = crypto.createHash("sha256").update(normalizedToken).digest("hex");
    const deviceRef = db.collection("staffDevices").doc(deviceID);
    const deviceDoc = await deviceRef.get();

    if (deviceDoc.exists && deviceDoc.data().staffUID === req.staff.uid) {
      await deviceRef.set({
        active: false,
        updatedAt: admin.firestore.FieldValue.serverTimestamp()
      }, { merge: true });
    }

    return res.json({ success: true });
  } catch (error) {
    console.error("unregister-device error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to unregister device"
    });
  }
});

app.get(
  "/reports",
  authenticateStaff,
  requireStaffPermission("canViewAllReports"),
  async (req, res) => {
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 25, 100);
      const cursor = req.query.cursor;

      let query = db
        .collection("reports")
        .orderBy("createdAt", "desc")
        .limit(limit);

      if (cursor) {
        const cursorDoc = await db.collection("reports").doc(cursor).get();

        if (cursorDoc.exists) {
          query = db
            .collection("reports")
            .orderBy("createdAt", "desc")
            .startAfter(cursorDoc)
            .limit(limit);
        }
      }

      const snapshot = await query.get();

      const reports = snapshot.docs.map((doc) => normalizeTimestampFields(doc.data()));

      const lastDoc = snapshot.docs.length > 0 ? snapshot.docs[snapshot.docs.length - 1] : null;
      const nextCursor = lastDoc ? lastDoc.id : null;
      const hasMore = snapshot.docs.length === limit;

      res.json({
        success: true,
        reports,
        nextCursor,
        hasMore
      });
    } catch (error) {
      console.error("get reports error:", error);
      res.status(500).json({
        success: false,
        error: "Failed to load reports"
      });
    }
  }
);

app.get("/reports/recent", authenticateStaff, requireStaffPermission("canViewAllReports"), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 10, 25);

    const snapshot = await db
      .collection("reports")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const reports = snapshot.docs.map((doc) => normalizeTimestampFields(doc.data()));

    res.json({
      success: true,
      reports
    });
  } catch (error) {
    console.error("GET /reports/recent error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to load recent reports"
    });
  }
});

app.get("/reports/map", authenticateStaff, requireStaffPermission("canViewAllReports"), async (req, res) => {
  try {
    const limit = Math.min(parseInt(req.query.limit, 10) || 100, 200);

    const snapshot = await db
      .collection("reports")
      .where("status", "!=", "resolved")
      .orderBy("status")
      .orderBy("createdAt", "desc")
      .limit(limit)
      .get();

    const reports = snapshot.docs
      .map((doc) => normalizeTimestampFields(doc.data()))
      .filter((report) => report.latitude != null && report.longitude != null);

    res.json({
      success: true,
      reports
    });
  } catch (error) {
    console.error("GET /reports/map error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to load map reports"
    });
  }
});

app.get("/reports/:id", authenticateStaff, requireStaffPermission("canViewAllReports"), async (req, res) => {
  try {
    const reportDoc = await db.collection("reports").doc(req.params.id).get();

    if (!reportDoc.exists) {
      return res.status(404).json({ success: false, error: "Report not found" });
    }

    return res.json({
      success: true,
      report: normalizeTimestampFields(reportDoc.data())
    });
  } catch (error) {
    console.error("GET /reports/:id error:", error);
    return res.status(500).json({
      success: false,
      error: "Failed to load report"
    });
  }
});

app.get("/report-status/:id", async (req, res) => {
  try {
    const { id } = req.params;

    const doc = await db.collection("reports").doc(id).get();

    if (!doc.exists) {
      return res.status(404).json({
        success: false,
        error: "Report not found"
      });
    }

    const report = doc.data();

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

app.patch("/reports/:id/status", authenticateStaff, requireStaffPermission("canViewAllReports"), async (req, res) => {
  try {
    const { id } = req.params;
    const { status } = req.body;

    const allowedStatuses = ["open", "in_progress", "resolved"];

    if (!allowedStatuses.includes(status)) {
      return res.status(400).json({
        success: false,
        error: "Invalid status"
      });
    }

    const reportRef = db.collection("reports").doc(id);
    const reportDoc = await reportRef.get();

    if (!reportDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "Report not found"
      });
    }

    await reportRef.update({
      status,
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    });

    const updatedDoc = await reportRef.get();
    const updatedReport = updatedDoc.data();

    try {
      await axios.post(
        `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`,
        {
          chat_id: TELEGRAM_CHAT_ID,
          text:
`🛠️ Incident Status Updated

Incident: ${updatedReport.incidentType}
New Status: ${status}
Report ID: ${id}`
        }
      );
    } catch (telegramError) {
      console.error(
        "Telegram status update error:",
        telegramError.response?.data || telegramError.message
      );
    }

    res.json({
      success: true,
      report: updatedReport
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
      clientReportId: providedClientReportId,
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

    if (providedClientReportId !== undefined && !isValidClientReportId(providedClientReportId)) {
      return res.status(400).json({
        success: false,
        error: "Invalid client report ID"
      });
    }

    const clientReportId = providedClientReportId || crypto.randomUUID();
    const reportTimestamp = timestamp || new Date().toISOString();

    const report = {
      incidentType: incidentType || "Other",
      description: description || "",
      location: location || "",
      isAnonymous: !!isAnonymous,
      timestamp: reportTimestamp,
      latitude: latitude ?? null,
      longitude: longitude ?? null,
      isEmergency: !!isEmergency,
      status: "open",
      hasPhoto: !!photoBase64,
      isMedicalHelp: isMedicalHelp === true,
      consciousStatus: consciousStatus || null,
      breathingStatus: breathingStatus || null,
      approximateAge: approximateAge || null,
      reporterName: isAnonymous ? null : (reporterName || null),
      reporterPhone: isAnonymous ? null : (reporterPhone || null),
      reporterInstagram: isAnonymous ? null : (reporterInstagram || null),
      contactNote: isAnonymous ? null : (contactNote || null),
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      updatedAt: admin.firestore.FieldValue.serverTimestamp()
    };

    const { reportId, deduplicated } = await createReportOnce(
      clientReportId,
      incidentType,
      report
    );

    if (deduplicated) {
      return res.json({
        success: true,
        reportId,
        deduplicated: true
      });
    }

    const deliveryWarnings = [];

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

    let medicalInfo = "";

    if (isMedicalHelp === true) {
      medicalInfo = `Medical Assistance Needed: Yes
Conscious: ${consciousStatus || "Not provided"}
Breathing Normally: ${breathingStatus || "Not provided"}
Approximate Age: ${approximateAge || "Not provided"}`;
    }

    const message = isEmergency
      ? `🚨 EMERGENCY ALERT

Incident: ${incidentType || "Other"}
Location: ${location || "Not provided"}
Description: ${description || "Not provided"}

${contactInfo}${medicalInfo ? `\n\n${medicalInfo}` : ""}

Report ID: ${reportId}

Map:
${gpsLink}`
      : `⚠️ Safety Report

Incident: ${incidentType || "Other"}
Location: ${location || "Not provided"}
Description: ${description || "Not provided"}

${contactInfo}${medicalInfo ? `\n\n${medicalInfo}` : ""}

Report ID: ${reportId}

Map:
${gpsLink}`;

    if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
      console.error("Telegram delivery skipped: missing environment variables");
      deliveryWarnings.push("telegram_not_configured");
    } else {
      try {
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
      } catch (telegramError) {
        console.error(
          "Telegram report delivery error:",
          telegramError.response?.data || telegramError.message
        );
        deliveryWarnings.push("telegram_delivery_failed");
      }
    }

    try {
      const staffDevicesSnapshot = await db
        .collection("staffDevices")
        .where("active", "==", true)
        .get();

      for (const deviceDoc of staffDevicesSnapshot.docs) {
        const device = deviceDoc.data();

        if (!device.fcmToken || !device.staffUID) {
          continue;
        }

        const deviceStaffDoc = await db.collection("staffUsers").doc(device.staffUID).get();

        if (!deviceStaffDoc.exists || deviceStaffDoc.data()?.active !== true) {
          await deviceDoc.ref.set({
            active: false,
            updatedAt: admin.firestore.FieldValue.serverTimestamp()
          }, { merge: true });
          continue;
        }

        try {
          await admin.messaging().send(buildStaffPushMessage({
            token: device.fcmToken,
            reportId,
            incidentType,
            location,
            timestamp: reportTimestamp,
            isEmergency,
            isAnonymous
          }));
        } catch (pushError) {
          console.error("Push failed:", pushError.message);

          if ([
            "messaging/registration-token-not-registered",
            "messaging/invalid-registration-token"
          ].includes(pushError.code)) {
            await deviceDoc.ref.delete();
          }
        }
      }
    } catch (pushDeliveryError) {
      console.error("Push delivery query failed:", pushDeliveryError.message);
      deliveryWarnings.push("push_delivery_failed");
    }

    return res.json({
      success: true,
      reportId,
      deduplicated: false,
      deliveryWarnings
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

app.delete("/admin/reports/:id", authenticateStaff, requireStaffRole("admin"), async (req, res) => {
  try {
    const { id } = req.params;

    const reportRef = db.collection("reports").doc(id);
    const reportDoc = await reportRef.get();

    if (!reportDoc.exists) {
      return res.status(404).json({
        success: false,
        error: "Report not found"
      });
    }

    const batch = db.batch();
    const clientReportId = reportDoc.data().clientReportId;

    batch.delete(reportRef);

    if (isValidClientReportId(clientReportId)) {
      batch.delete(db.collection("reportRequests").doc(clientReportId));
    }

    await batch.commit();

    res.json({
      success: true,
      message: `Report ${id} deleted`
    });
  } catch (error) {
    console.error("DELETE /admin/reports/:id error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete report"
    });
  }
});

app.delete("/admin/reports", authenticateStaff, requireStaffRole("admin"), async (req, res) => {
  try {
    const [reportsSnapshot, requestsSnapshot] = await Promise.all([
      db.collection("reports").get(),
      db.collection("reportRequests").get()
    ]);
    const docs = [...reportsSnapshot.docs, ...requestsSnapshot.docs];

    const deletedCount = reportsSnapshot.size;
    const deletedRequestCount = requestsSnapshot.size;
    const batchSize = 400;

    for (let i = 0; i < docs.length; i += batchSize) {
      const batch = db.batch();
      const chunk = docs.slice(i, i + batchSize);

      chunk.forEach((doc) => {
        batch.delete(doc.ref);
      });

      await batch.commit();
    }

    res.json({
      success: true,
      message: "All reports deleted",
      deletedCount,
      deletedRequestCount
    });
  } catch (error) {
    console.error("DELETE /admin/reports error:", error);
    res.status(500).json({
      success: false,
      error: "Failed to delete all reports"
    });
  }
});

app.get("/admin/staff-users", authenticateStaff, requireStaffPermission("canManageStaff"), async (req, res) => {
  try {
    const snapshot = await db.collection("staffUsers").get();

    const staffUsers = snapshot.docs.map((doc) => {
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

app.post("/admin/create-staff", authenticateStaff, requireStaffPermission("canManageStaff"), async (req, res) => {
  try {
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

    if (active !== undefined && typeof active !== "boolean") {
      return res.status(400).json({ success: false, error: "Active must be a boolean" });
    }

    if (matchesStaffRole({ role }, "admin") && !hasStaffRole(req.staff.profile, "admin")) {
      return res.status(403).json({
        success: false,
        error: "Only an admin can create another admin"
      });
    }

    if (!name || !email || !password || !role || !team) {
      return res.status(400).json({
        success: false,
        error: "Missing required fields"
      });
    }

    if (password.length < 6) {
      return res.status(400).json({
        success: false,
        error: "Password must be at least 6 characters"
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
      createdBy: req.staff.uid,
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    });

    res.json({
      success: true,
      uid: userRecord.uid
    });
  } catch (error) {
    console.error("POST /admin/create-staff error:", error);

    if (error.code === "auth/email-already-exists") {
      return res.status(400).json({
        success: false,
        error: "That email is already registered"
      });
    }

    if (error.code === "auth/invalid-password") {
      return res.status(400).json({
        success: false,
        error: "Invalid password"
      });
    }

    if (error.code === "auth/invalid-email") {
      return res.status(400).json({
        success: false,
        error: "Invalid email address"
      });
    }

    res.status(500).json({
      success: false,
      error: "Failed to create staff"
    });
  }
});

app.patch("/admin/update-staff/:uid", authenticateStaff, requireStaffPermission("canManageStaff"), async (req, res) => {
  try {
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

    if (active !== undefined && typeof active !== "boolean") {
      return res.status(400).json({ success: false, error: "Active must be a boolean" });
    }

    if (uid === req.staff.uid && active === false) {
      return res.status(400).json({
        success: false,
        error: "You cannot deactivate your own staff account"
      });
    }

    if (uid === req.staff.uid && canManageStaff === false) {
      return res.status(400).json({
        success: false,
        error: "You cannot remove your own staff management permission"
      });
    }

    const staffRef = db.collection("staffUsers").doc(uid);
    const staffDoc = await staffRef.get();

    if (!staffDoc.exists) {
      return res.status(404).json({ success: false, error: "Staff profile not found" });
    }

    const actorIsAdmin = hasStaffRole(req.staff.profile, "admin");
    const targetIsAdmin = matchesStaffRole(staffDoc.data(), "admin");
    const grantsAdminRole = role !== undefined && matchesStaffRole({ role }, "admin");

    if (!actorIsAdmin && (targetIsAdmin || grantsAdminRole)) {
      return res.status(403).json({
        success: false,
        error: "Only an admin can modify admin accounts or grant the admin role"
      });
    }

    const updates = {};

    if (name !== undefined) updates.name = name;
    if (role !== undefined) updates.role = role;
    if (team !== undefined) updates.team = team;
    if (active !== undefined) updates.active = active;
    if (canManageStaff !== undefined) updates.canManageStaff = canManageStaff;
    if (canEditEventInfo !== undefined) updates.canEditEventInfo = canEditEventInfo;
    if (canUseStaffChat !== undefined) updates.canUseStaffChat = canUseStaffChat;
    if (canViewAllReports !== undefined) updates.canViewAllReports = canViewAllReports;

    updates.updatedBy = req.staff.uid;
    updates.updatedAt = admin.firestore.FieldValue.serverTimestamp();

    await staffRef.update(updates);

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

app.patch("/admin/toggle-staff/:uid", authenticateStaff, requireStaffPermission("canManageStaff"), async (req, res) => {
  try {
    const { uid } = req.params;
    const { active } = req.body;

    if (typeof active !== "boolean") {
      return res.status(400).json({
        success: false,
        error: "Active must be a boolean"
      });
    }

    if (uid === req.staff.uid && active === false) {
      return res.status(400).json({
        success: false,
        error: "You cannot deactivate your own staff account"
      });
    }

    const staffRef = db.collection("staffUsers").doc(uid);
    const staffDoc = await staffRef.get();

    if (!staffDoc.exists) {
      return res.status(404).json({ success: false, error: "Staff profile not found" });
    }

    if (matchesStaffRole(staffDoc.data(), "admin") && !hasStaffRole(req.staff.profile, "admin")) {
      return res.status(403).json({
        success: false,
        error: "Only an admin can activate or deactivate another admin"
      });
    }

    await staffRef.update({
      active,
      updatedBy: req.staff.uid,
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
