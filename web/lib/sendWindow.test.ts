import { describe, expect, it } from "vitest";
import { sendWindowLabel, validateSendWindow } from "./sendWindow";

describe("validateSendWindow", () => {
  it("accepts a same-day HH:MM window with a time zone", () => {
    expect(validateSendWindow({ start: "09:00", end: "10:00", tz: "Asia/Kolkata" })).toEqual({});
  });
  it("rejects malformed times, equal or reversed times and a blank zone", () => {
    expect(validateSendWindow({ start: "9:00", end: "10:00", tz: "UTC" }).start).toMatch(/HH:MM/);
    expect(validateSendWindow({ start: "09:00", end: "24:00", tz: "UTC" }).end).toMatch(/HH:MM/);
    expect(validateSendWindow({ start: "10:00", end: "10:00", tz: "UTC" }).end).toMatch(/after/);
    expect(validateSendWindow({ start: "11:00", end: "10:00", tz: "UTC" }).end).toMatch(/after/);
    expect(validateSendWindow({ start: "09:00", end: "10:00", tz: " " }).tz).toBeTruthy();
  });
});

describe("sendWindowLabel", () => {
  it("joins the times with an en dash and appends the zone", () => {
    expect(sendWindowLabel({ start: "09:00", end: "10:00", tz: "Asia/Kolkata" })).toBe("09:00–10:00 Asia/Kolkata");
  });
});
