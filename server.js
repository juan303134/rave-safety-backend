const express = require("express")
const cors = require("cors")
const axios = require("axios")
const admin = require("firebase-admin")

const app = express()
app.use(cors())
app.use(express.json())

const TELEGRAM_TOKEN = process.env.TELEGRAM_TOKEN
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID

admin.initializeApp({
  credential: admin.credential.applicationDefault()
})

const db = admin.firestore()

/* ------------------------------------------------ */
/* REPORT ID GENERATOR */
/* ------------------------------------------------ */

async function generateReportID() {
  const counterRef = db.collection("system").doc("reportCounter")

  const newValue = await db.runTransaction(async (tx) => {
    const doc = await tx.get(counterRef)

    let value = 0

    if (doc.exists) {
      value = doc.data().value || 0
    }

    value += 1

    tx.set(counterRef, { value })

    return value
  })

  return `R${newValue}`
}

/* ------------------------------------------------ */
/* VERIFY ADMIN ACCESS */
/* ------------------------------------------------ */

async function verifyAdminAccess(req) {
  try {
    const uid = req.headers["x-staff-uid"]

    if (!uid) {
      return { ok: false, status: 401, error: "Missing staff uid" }
    }

    const doc = await db.collection("staffUsers").doc(uid).get()

    if (!doc.exists) {
      return { ok: false, status: 403, error: "Staff profile not found" }
    }

    const data = doc.data() || {}

    if (!data.active) {
      return { ok: false, status: 403, error: "Staff account inactive" }
    }

    if (!data.canManageStaff) {
      return { ok: false, status: 403, error: "No permission to manage staff" }
    }

    return { ok: true, uid, profile: data }

  } catch (error) {
    console.error("verifyAdminAccess error:", error)
    return { ok: false, status: 500, error: "Admin verification failed" }
  }
}

/* ------------------------------------------------ */
/* SEND REPORT */
/* ------------------------------------------------ */

app.post("/report", async (req, res) => {

  try {

    const id = await generateReportID()

    const report = {
      id,
      incidentType: req.body.incidentType || "Unknown",
      description: req.body.description || "",
      location: req.body.location || "",
      latitude: req.body.latitude || null,
      longitude: req.body.longitude || null,
      timestamp: new Date().toISOString(),
      status: "open",
      isEmergency: req.body.isEmergency || false,
      isAnonymous: req.body.isAnonymous || true,
      hasPhoto: req.body.hasPhoto || false
    }

    await db.collection("reports").doc(id).set(report)

    const message =
`🚨 NEW INCIDENT REPORT

ID: ${report.id}
Type: ${report.incidentType}

Description:
${report.description}

Location:
${report.location}

Emergency: ${report.isEmergency ? "YES" : "NO"}`

    await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`, {
      chat_id: TELEGRAM_CHAT_ID,
      text: message
    })

    res.json({
      success: true,
      reportID: id
    })

  } catch (error) {

    console.error("Report error:", error)

    res.status(500).json({
      success: false,
      error: "Failed to submit report"
    })
  }
})

/* ------------------------------------------------ */
/* GET REPORTS */
/* ------------------------------------------------ */

app.get("/reports", async (req, res) => {

  try {

    const snapshot = await db.collection("reports").get()

    const reports = snapshot.docs.map(doc => doc.data())

    res.json({
      success: true,
      reports
    })

  } catch (error) {

    console.error("Reports error:", error)

    res.status(500).json({
      success: false
    })
  }
})

/* ------------------------------------------------ */
/* GET STAFF USERS */
/* ------------------------------------------------ */

app.get("/admin/staff-users", async (req, res) => {

  try {

    const access = await verifyAdminAccess(req)

    if (!access.ok) {
      return res.status(access.status).json({
        success: false,
        error: access.error
      })
    }

    const snapshot = await db.collection("staffUsers").get()

    const staffUsers = snapshot.docs.map(doc => {

      const data = doc.data() || {}

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
      }
    })

    res.json({
      success: true,
      staffUsers
    })

  } catch (error) {

    console.error("staff-users error:", error)

    res.status(500).json({
      success: false,
      error: "Failed to load staff users"
    })
  }
})

/* ------------------------------------------------ */
/* CREATE STAFF */
/* ------------------------------------------------ */

app.post("/admin/create-staff", async (req, res) => {

  try {

    const access = await verifyAdminAccess(req)

    if (!access.ok) {
      return res.status(access.status).json({
        success: false,
        error: access.error
      })
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
    } = req.body

    const user = await admin.auth().createUser({
      email,
      password
    })

    const uid = user.uid

    await db.collection("staffUsers").doc(uid).set({
      name,
      email,
      role,
      team,
      active,
      canManageStaff,
      canEditEventInfo,
      canUseStaffChat,
      canViewAllReports
    })

    res.json({
      success: true,
      uid
    })

  } catch (error) {

    console.error("create-staff error:", error)

    res.status(500).json({
      success: false,
      error: "Failed to create staff"
    })
  }
})

/* ------------------------------------------------ */
/* UPDATE STAFF */
/* ------------------------------------------------ */

app.patch("/admin/update-staff/:uid", async (req, res) => {

  try {

    const access = await verifyAdminAccess(req)

    if (!access.ok) {
      return res.status(access.status).json({
        success: false,
        error: access.error
      })
    }

    const uid = req.params.uid

    await db.collection("staffUsers").doc(uid).update(req.body)

    res.json({
      success: true
    })

  } catch (error) {

    console.error("update-staff error:", error)

    res.status(500).json({
      success: false,
      error: "Failed to update staff"
    })
  }
})

/* ------------------------------------------------ */
/* TOGGLE STAFF */
/* ------------------------------------------------ */

app.patch("/admin/toggle-staff/:uid", async (req, res) => {

  try {

    const access = await verifyAdminAccess(req)

    if (!access.ok) {
      return res.status(access.status).json({
        success: false,
        error: access.error
      })
    }

    const uid = req.params.uid
    const active = req.body.active

    await db.collection("staffUsers").doc(uid).update({
      active
    })

    res.json({
      success: true
    })

  } catch (error) {

    console.error("toggle staff error:", error)

    res.status(500).json({
      success: false
    })
  }
})

/* ------------------------------------------------ */
/* SERVER */
/* ------------------------------------------------ */

const PORT = process.env.PORT || 3000

app.listen(PORT, () => {
  console.log("Server running on port", PORT)
})