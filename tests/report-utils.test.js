const test = require("node:test");
const assert = require("node:assert/strict");

const {
  buildStaffPushMessage,
  getIncidentPrefix,
  isValidClientReportId
} = require("../report-utils");

test("maps incident types to stable report prefixes", () => {
  assert.equal(getIncidentPrefix("Medical Emergency"), "MED");
  assert.equal(getIncidentPrefix("Harassment"), "HAR");
  assert.equal(getIncidentPrefix("Violence"), "SEC");
  assert.equal(getIncidentPrefix("Theft"), "THE");
  assert.equal(getIncidentPrefix("Suspicious Activity"), "SUS");
  assert.equal(getIncidentPrefix("Other"), "GEN");
});

test("accepts safe idempotency keys and rejects unsafe document IDs", () => {
  assert.equal(isValidClientReportId("c8592fa2-8146-4a19-98e3-93b1c9140d87"), true);
  assert.equal(isValidClientReportId("short"), false);
  assert.equal(isValidClientReportId("../../staffUsers/admin"), false);
  assert.equal(isValidClientReportId("contains spaces and symbols!"), false);
});

test("builds a tappable iOS push payload with a badge", () => {
  const message = buildStaffPushMessage({
    token: "device-token",
    reportId: "MED042",
    incidentType: "Medical Emergency",
    location: "Main Stage",
    timestamp: "Aug 9, 2026 1:00 PM",
    isEmergency: true,
    isAnonymous: false
  });

  assert.equal(message.token, "device-token");
  assert.equal(message.data.reportId, "MED042");
  assert.equal(message.data.isEmergency, "true");
  assert.equal(message.notification.title, "🚨 Emergency Alert");
  assert.equal(message.apns.payload.aps.sound, "default");
  assert.equal(message.apns.payload.aps.badge, 1);
});
