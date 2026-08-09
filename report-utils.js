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

function hasStaffPermission(profile, permission) {
  return profile?.active === true && profile?.[permission] === true;
}

function matchesStaffRole(profile, role) {
  return typeof profile?.role === "string" &&
    profile.role.trim().toLowerCase() === role.trim().toLowerCase();
}

function hasStaffRole(profile, role) {
  return profile?.active === true && matchesStaffRole(profile, role);
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
  hasStaffPermission,
  hasStaffRole,
  isValidClientReportId,
  matchesStaffRole
};
