import { describe, it, expect } from "vitest";
import { transferBadge, TRANSFER_VERBS, accessReasonLabel, isNativeRdpMethod } from "./access-format";

describe("transferBadge", () => {
  it("maps DOWNLOAD", () => {
    expect(transferBadge("DOWNLOAD")).toEqual({ isTransfer: true, direction: "download", partial: false, label: "Download" });
  });
  it("maps UPLOAD", () => {
    expect(transferBadge("UPLOAD")).toEqual({ isTransfer: true, direction: "upload", partial: false, label: "Upload" });
  });
  it("maps DOWNLOAD-PARTIAL as partial", () => {
    expect(transferBadge("DOWNLOAD-PARTIAL")).toEqual({ isTransfer: true, direction: "download", partial: true, label: "Download (partial)" });
  });
  it("maps UPLOAD-PARTIAL as partial", () => {
    expect(transferBadge("UPLOAD-PARTIAL")).toEqual({ isTransfer: true, direction: "upload", partial: true, label: "Upload (partial)" });
  });
  it("treats a normal HTTP method as not a transfer", () => {
    expect(transferBadge("GET")).toEqual({ isTransfer: false });
  });
  it("TRANSFER_VERBS holds exactly the four verbs", () => {
    expect([...TRANSFER_VERBS]).toEqual(["DOWNLOAD", "UPLOAD", "DOWNLOAD-PARTIAL", "UPLOAD-PARTIAL"]);
  });
});

describe("accessReasonLabel", () => {
  it("words the access check's codes", () => {
    expect(accessReasonLabel("no_grant")).toBe("No grant for this resource");
    expect(accessReasonLabel("ip_not_allowed")).toBe("Network not on the IP allowlist");
  });
  it("keeps the session length after session_close", () => {
    expect(accessReasonLabel("session_close 12m 4s")).toBe("Session closed · 12m 4s");
  });
  it("names the requests a recording replay made", () => {
    expect(accessReasonLabel("replay")).toBe("Loaded by a recording replay");
  });
  it("shows an unknown code as stored, and nothing for none", () => {
    expect(accessReasonLabel("something_new")).toBe("something_new");
    expect(accessReasonLabel(null)).toBeNull();
    expect(accessReasonLabel("")).toBeNull();
  });
});

describe("native RDP sessions", () => {
  it("name the user's own app instead of a code", () => {
    expect(accessReasonLabel("session_open native_rdp")).toBe("Session opened · own RDP app");
    expect(accessReasonLabel("session_open native_ssh")).toBe("Session opened · own SSH app");
    expect(accessReasonLabel("native_ssh_no_grant")).toBe("No grant for this resource · own SSH app");
    expect(accessReasonLabel("native_rdp_not_allowed")).toBe("Not allowed in the user's own app · own RDP app");
    expect(accessReasonLabel("session_close 21s")).toBe("Session closed · 21s");
  });
  it("recognise the RD Gateway request they are stored under", () => {
    expect(isNativeRdpMethod("RDG_OUT_DATA")).toBe(true);
    expect(isNativeRdpMethod("GET")).toBe(false);
  });
});
