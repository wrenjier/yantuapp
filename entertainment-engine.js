(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.EntertainmentEngine = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function numberOrZero(value) {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  }

  function entitlementFor({ completedTaskCount, estimatedScore }) {
    if (numberOrZero(completedTaskCount) < 1) return 0;
    if (numberOrZero(estimatedScore) >= 90) return 90;
    if (numberOrZero(estimatedScore) >= 80) return 60;
    return 30;
  }

  function allowanceShape(current) {
    const allowance = current || {};
    const shaped = {
      date: allowance.date,
      unlockedMinutes: Math.max(0, numberOrZero(allowance.unlockedMinutes)),
      usedSeconds: Math.max(0, numberOrZero(allowance.usedSeconds)),
      expired: Boolean(allowance.expired)
    };
    if (validCutoffTime(allowance.cutoffTime)) shaped.cutoffTime = allowance.cutoffTime;
    if (validSettingsSnapshot(allowance.settingsSnapshot)) shaped.settingsSnapshot = { ...allowance.settingsSnapshot };
    return shaped;
  }

  function validCutoffTime(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
    return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
  }

  function validSettingsSnapshot(value) {
    return Boolean(value && [value.reminderTime, value.cutoffTime, value.sleepTarget, value.wakeTarget].every(validCutoffTime));
  }

  function canonicalEntitlement(entitledMinutes) {
    const minutes = numberOrZero(entitledMinutes);
    if (minutes >= 90) return 90;
    if (minutes >= 60) return 60;
    if (minutes >= 30) return 30;
    return 0;
  }

  function assertValidDate(date) {
    if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw new TypeError("date 必须是有效的 YYYY-MM-DD");
    }
    const [year, month, day] = date.split("-").map(Number);
    const localDate = new Date(0);
    localDate.setHours(0, 0, 0, 0);
    localDate.setFullYear(year, month - 1, day);
    if (
      localDate.getFullYear() !== year ||
      localDate.getMonth() !== month - 1 ||
      localDate.getDate() !== day
    ) {
      throw new TypeError("date 必须是有效的 YYYY-MM-DD");
    }
  }

  function reconcileAllowance(current, { date, entitledMinutes, afterCutoff, cutoffTime, settingsSnapshot }) {
    assertValidDate(date);
    const allowance = allowanceShape(current);
    const unlockedMinutes = canonicalEntitlement(entitledMinutes);
    if (allowance.date !== date) {
      const created = {
        date,
        unlockedMinutes,
        usedSeconds: 0,
        expired: Boolean(afterCutoff)
      };
      if (validCutoffTime(cutoffTime)) created.cutoffTime = cutoffTime;
      if (validSettingsSnapshot(settingsSnapshot)) created.settingsSnapshot = { ...settingsSnapshot };
      return created;
    }
    if (allowance.expired) return allowance;
    const reconciled = {
      date,
      unlockedMinutes: Math.max(allowance.unlockedMinutes, unlockedMinutes),
      usedSeconds: allowance.usedSeconds,
      expired: allowance.expired || Boolean(afterCutoff)
    };
    const effectiveCutoff = allowance.cutoffTime || (validCutoffTime(cutoffTime) ? cutoffTime : null);
    if (effectiveCutoff) reconciled.cutoffTime = effectiveCutoff;
    const effectiveSnapshot = allowance.settingsSnapshot || (validSettingsSnapshot(settingsSnapshot) ? settingsSnapshot : null);
    if (effectiveSnapshot) reconciled.settingsSnapshot = { ...effectiveSnapshot };
    return reconciled;
  }

  function remainingSeconds(allowance) {
    const current = allowanceShape(allowance);
    if (current.expired) return 0;
    return Math.max(0, Math.floor(current.unlockedMinutes * 60 - current.usedSeconds));
  }

  function isAtOrAfterCutoff(now, cutoffTime) {
    const date = now instanceof Date ? now : new Date(now);
    const match = /^(\d{1,2}):(\d{2})$/.exec(String(cutoffTime || ""));
    if (Number.isNaN(date.getTime()) || !match) return false;
    const hours = Number(match[1]);
    const minutes = Number(match[2]);
    if (hours > 23 || minutes > 59) return false;
    return date.getHours() * 60 + date.getMinutes() >= hours * 60 + minutes;
  }

  function startSession({ id, date, deviceLabel, startedAt, cutoffTime, settingsSnapshot }) {
    const session = {
      id,
      date,
      deviceLabel,
      startedAt,
      endedAt: null,
      durationSeconds: 0,
      endReason: null,
      notifiedAt: null
    };
    if (validCutoffTime(cutoffTime)) session.cutoffTime = cutoffTime;
    if (validSettingsSnapshot(settingsSnapshot)) session.settingsSnapshot = { ...settingsSnapshot };
    return session;
  }

  function stopSession(session, endedAt, reason) {
    const startedMs = Date.parse(session && session.startedAt);
    const endedMs = Date.parse(endedAt);
    const durationSeconds = Number.isFinite(startedMs) && Number.isFinite(endedMs)
      ? Math.max(0, Math.floor((endedMs - startedMs) / 1000))
      : 0;
    return Object.assign({}, session, {
      endedAt,
      durationSeconds,
      endReason: reason
    });
  }

  function expireAtCutoff({ allowance, activeSession, nowIso }) {
    return {
      allowance: Object.assign({}, allowanceShape(allowance), { expired: true }),
      session: activeSession ? stopSession(activeSession, nowIso, "cutoff") : null
    };
  }

  function routinePercent({ stopDelayMinutes, sleepOnTime, wakeOnTime, hasSleep, hasWake }) {
    if (!hasSleep || !hasWake) return 0;
    const delay = numberOrZero(stopDelayMinutes);
    if (delay > 30) return 0;
    if (delay <= 0 && sleepOnTime && wakeOnTime) return 100;
    return 50;
  }

  return {
    entitlementFor,
    reconcileAllowance,
    remainingSeconds,
    isAtOrAfterCutoff,
    startSession,
    stopSession,
    expireAtCutoff,
    routinePercent
  };
});
