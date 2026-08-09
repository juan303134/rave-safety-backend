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

function isValidClientReportId(value) {
  return typeof value === "string" && /^[A-Za-z0-9_-]{16,128}$/.test(value);
}

function buildStaffPushMessage({
  token,
  reportId,
  incidentType,
  location,
  timestamp,
  isEmergency,
  isAnonymous
}) {
  return {
    token,
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
          sound: "default",
          badge: 1
        }
      }
    }
  };
}

module.exports = {
  buildStaffPushMessage,
  getIncidentPrefix,
  isValidClientReportId
};
