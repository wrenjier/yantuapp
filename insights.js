(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.RewardInsights = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  "use strict";

  function parseDate(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(value || ""));
    if (!match) throw new TypeError("日期必须是有效的 YYYY-MM-DD");
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
      throw new TypeError("日期必须是有效的 YYYY-MM-DD");
    }
    return date;
  }

  function dateString(date) {
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, "0")}-${String(date.getUTCDate()).padStart(2, "0")}`;
  }

  function addDate(date, days) {
    const next = new Date(date.getTime());
    next.setUTCDate(next.getUTCDate() + days);
    return next;
  }

  function numberOrNull(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function clamp(value, min, max) {
    const number = numberOrNull(value);
    return Math.min(max, Math.max(min, number === null ? 0 : number));
  }

  function scoreFor(record) {
    if (!record) return null;
    const savedScore = numberOrNull(record.score);
    if (savedScore !== null) return savedScore;
    const parts = [
      clamp(record.studyHours, 0, 8) / 8 * 25,
      clamp(record.taskRate, 0, 100) / 100 * 30,
      clamp(record.review, 0, 100) / 100 * 15,
      clamp(record.routine, 0, 100) / 100 * 10,
      clamp(record.exercise, 0, 100) / 100 * 10,
      clamp(record.honesty, 0, 100) / 100 * 10
    ].map((part) => Math.round(part * 10) / 10);
    return Math.round(parts.reduce((sum, part) => sum + part, 0) * 10) / 10;
  }

  function validTime(value) {
    const match = /^(\d{2}):(\d{2})$/.exec(String(value || ""));
    return Boolean(match && Number(match[1]) <= 23 && Number(match[2]) <= 59);
  }

  function timeMinutes(value, kind) {
    if (!validTime(value)) return null;
    const [hours, minutes] = value.split(":").map(Number);
    const clockMinutes = hours * 60 + minutes;
    // 睡眠日时间轴从当天傍晚延伸到次日上午：次日起床统一加 1440，
    // 午夜后的入睡也加 1440，因此 23:30=1410、00:30=1470、07:00 起床=1860。
    if (kind === "wake") return clockMinutes + 1440;
    return clockMinutes < 12 * 60 ? clockMinutes + 1440 : clockMinutes;
  }

  function explicitOvertime(value) {
    if (!value || typeof value !== "object") return null;
    if (typeof value.overtime === "boolean") return value.overtime;
    if (typeof value.cutoffCompliant === "boolean") return !value.cutoffCompliant;
    if (typeof value.compliant === "boolean") return !value.compliant;
    const delay = numberOrNull(value.stopDelayMinutes);
    if (delay !== null) return delay > 0;
    const status = String(value.compliance || value.cutoffStatus || "").toLowerCase();
    if (["overtime", "late", "超时"].includes(status)) return true;
    if (["ontime", "on-time", "compliant", "按时"].includes(status)) return false;
    return null;
  }

  function cutoffFor(session, allowance) {
    const values = [
      session && session.cutoffTime,
      session && session.settingsSnapshot && session.settingsSnapshot.cutoffTime,
      allowance && allowance.cutoffTime,
      allowance && allowance.settingsSnapshot && allowance.settingsSnapshot.cutoffTime
    ];
    return values.find(validTime) || null;
  }

  function endedAfterCutoff(session, allowance) {
    if (!session || !session.endedAt || !session.date) return null;
    const cutoffTime = cutoffFor(session, allowance);
    if (!cutoffTime) return explicitOvertime(session);
    let ownedDate;
    try {
      ownedDate = parseDate(session.date);
    } catch (_) {
      return explicitOvertime(session);
    }
    const [hours, minutes] = cutoffTime.split(":").map(Number);
    const cutoff = new Date(
      ownedDate.getUTCFullYear(),
      ownedDate.getUTCMonth(),
      ownedDate.getUTCDate(),
      hours,
      minutes,
      0,
      0
    );
    const ended = Date.parse(session.endedAt);
    return Number.isFinite(ended) ? ended > cutoff.getTime() : explicitOvertime(session);
  }

  function overtimeFor(sleepRecord, allowance, sessions) {
    const evidence = [];
    [sleepRecord, allowance].forEach((item) => {
      const value = explicitOvertime(item);
      if (value !== null) evidence.push(value);
    });
    sessions.forEach((session) => {
      const explicit = explicitOvertime(session);
      if (explicit !== null) evidence.push(explicit);
      const cutoffResult = endedAfterCutoff(session, allowance);
      if (cutoffResult !== null) evidence.push(cutoffResult);
    });
    if (evidence.includes(true)) return true;
    if (evidence.includes(false)) return false;
    return null;
  }

  function buildDailyInsights(state, start, end) {
    const startDate = parseDate(start);
    const endDate = parseDate(end);
    if (startDate.getTime() > endDate.getTime()) throw new RangeError("日期范围必须从早到晚");
    const source = state && typeof state === "object" ? state : {};
    const records = Array.isArray(source.records) ? source.records : [];
    const sessions = Array.isArray(source.sessions) ? source.sessions : [];
    const sleepRecords = source.sleepRecords && typeof source.sleepRecords === "object" ? source.sleepRecords : {};
    const allowances = source.allowances && typeof source.allowances === "object" ? source.allowances : {};
    const points = [];

    for (let cursor = startDate; cursor.getTime() <= endDate.getTime(); cursor = addDate(cursor, 1)) {
      const date = dateString(cursor);
      const record = records.find((item) => item && item.date === date) || null;
      const daySessions = sessions.filter((item) => item && item.date === date && item.endedAt);
      const sleepRecord = sleepRecords[date] || null;
      const allowance = allowances[date] || null;
      const usedMinutes = daySessions.length
        ? Math.round(daySessions.reduce((sum, session) => sum + Math.max(0, numberOrNull(session.durationSeconds) || 0), 0) / 6) / 10
        : null;
      points.push({
        date,
        score: scoreFor(record),
        usedMinutes,
        sleepMinutes: sleepRecord ? timeMinutes(sleepRecord.sleepTime, "sleep") : null,
        wakeMinutes: sleepRecord ? timeMinutes(sleepRecord.wakeTime, "wake") : null,
        overtime: overtimeFor(sleepRecord, allowance, daySessions)
      });
    }
    return points;
  }

  function consecutiveOvertimeDays(points) {
    const ordered = (Array.isArray(points) ? points : [])
      .filter((point) => point && typeof point.date === "string")
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date));
    let count = 0;
    let expectedDate = null;
    for (let index = ordered.length - 1; index >= 0; index -= 1) {
      const point = ordered[index];
      let currentDate;
      try {
        currentDate = parseDate(point.date);
      } catch (_) {
        break;
      }
      if (expectedDate && currentDate.getTime() !== expectedDate.getTime()) break;
      if (point.overtime !== true) break;
      count += 1;
      expectedDate = addDate(currentDate, -1);
    }
    return count;
  }

  return { buildDailyInsights, consecutiveOvertimeDays };
});
