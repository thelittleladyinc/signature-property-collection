"use strict";
// suite-kit: Denver time and daylight saving, ONE copy (Duplication Audit, Oct 11: four daylight-saving
// checks, each with its own idea of when Mountain time changes).
//
// Christine's business runs on America/Denver wall time: "a Denver day", "7:30 AM", "Monday 05:30". These
// helpers read the zone through Intl (built into Node, Deno and browsers), never a hand-kept DST table, so
// a rule change follows the platform's time-zone data. US rule today: MDT (UTC-6) from the second Sunday
// of March at 2:00 AM to the first Sunday of November at 2:00 AM, MST (UTC-7) otherwise.
//
// Wall times that do not exist (the spring-forward hour, 2:00-2:59 AM) resolve to the same clock time
// one hour later; wall times that happen twice (the fall-back hour, 1:00-1:59 AM) resolve to the FIRST
// (MDT) one. Both are documented by tests.
Object.defineProperty(exports, "__esModule", { value: true });
exports.DENVER_TZ = void 0;
exports.denverParts = denverParts;
exports.denverDate = denverDate;
exports.isDenverDst = isDenverDst;
exports.denverIso = denverIso;
exports.denverWallTime = denverWallTime;
exports.startOfDenverDay = startOfDenverDay;
exports.addDenverDays = addDenverDays;
exports.denverDstChanges = denverDstChanges;
exports.isDenverWeekdayAtOrAfter = isDenverWeekdayAtOrAfter;
exports.DENVER_TZ = 'America/Denver';
const FORMAT = new Intl.DateTimeFormat('en-US', {
    timeZone: exports.DENVER_TZ, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short',
});
const WEEKDAYS = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
function toDate(at) {
    const d = at instanceof Date ? at : new Date(at);
    if (!Number.isFinite(d.getTime()))
        throw new RangeError('not a valid time');
    return d;
}
/** The Denver wall-clock reading of an instant. */
function denverParts(at = new Date()) {
    const d = toDate(at);
    const p = {};
    for (const part of FORMAT.formatToParts(d))
        p[part.type] = part.value;
    const year = Number(p.year), month = Number(p.month), day = Number(p.day);
    const hour = Number(p.hour) % 24, minute = Number(p.minute), second = Number(p.second);
    const wall = Date.UTC(year, month - 1, day, hour, minute, second);
    const offsetMinutes = Math.round((wall - Math.floor(d.getTime() / 1000) * 1000) / 60000);
    return { year, month, day, hour, minute, second, weekday: WEEKDAYS[p.weekday] ?? 0, offsetMinutes };
}
const pad = (n, w = 2) => String(n).padStart(w, '0');
/** The Denver calendar date, "2026-10-17". */
function denverDate(at = new Date()) {
    const p = denverParts(at);
    return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}`;
}
/** True while Denver keeps daylight time (MDT, UTC-6). */
function isDenverDst(at = new Date()) {
    return denverParts(at).offsetMinutes === -360;
}
/** Wall-clock time with its offset, e.g. "2026-10-01T09:00:00-06:00" (the shape Lofty's task API takes). */
function denverIso(at = new Date()) {
    const p = denverParts(at);
    const abs = Math.abs(p.offsetMinutes);
    const off = `${p.offsetMinutes < 0 ? '-' : '+'}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`;
    return `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)}T${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}${off}`;
}
/**
 * The instant at which Denver's clock reads this wall time. A time skipped by spring-forward moves one
 * hour later (2:30 AM → 3:30 AM MDT); a time repeated by fall-back is the first one (MDT).
 */
function denverWallTime(year, month, day, hour = 0, minute = 0, second = 0) {
    for (const n of [year, month, day, hour, minute, second]) {
        if (!Number.isInteger(n))
            throw new RangeError('wall time parts must be whole numbers');
    }
    const wall = Date.UTC(year, month - 1, day, hour, minute, second);
    // Try MDT first (the earlier instant when both readings exist), then MST.
    for (const offset of [-360, -420]) {
        const guess = wall - offset * 60000;
        const p = denverParts(guess);
        if (Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second) === wall)
            return new Date(guess);
    }
    // In the spring-forward gap: read with the standard-time offset, which lands one hour later in MDT.
    return new Date(wall + 420 * 60000);
}
/** Midnight at the start of this instant's Denver day. */
function startOfDenverDay(at = new Date()) {
    const p = denverParts(at);
    return denverWallTime(p.year, p.month, p.day);
}
/** The Denver calendar date `days` after this instant's (negative for before), "2026-10-18". */
function addDenverDays(at, days) {
    const p = denverParts(at);
    const d = new Date(Date.UTC(p.year, p.month - 1, p.day + days));
    return `${pad(d.getUTCFullYear(), 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}
/** The two instants Denver's clocks change in a year: spring forward (to MDT) and fall back (to MST). */
function denverDstChanges(year) {
    const nthSunday = (month, n) => {
        const first = new Date(Date.UTC(year, month - 1, 1)).getUTCDay();
        return 1 + ((7 - first) % 7) + 7 * (n - 1);
    };
    // 2:00 AM MST = 09:00 UTC (second Sunday of March); 2:00 AM MDT = 08:00 UTC (first Sunday of November).
    return {
        springForward: new Date(Date.UTC(year, 2, nthSunday(3, 2), 9)),
        fallBack: new Date(Date.UTC(year, 10, nthSunday(11, 1), 8)),
    };
}
/** True when the instant falls on this Denver weekday (0 = Sunday) at or after hh:mm Denver time. */
function isDenverWeekdayAtOrAfter(at, weekday, hour, minute = 0) {
    const p = denverParts(at);
    return p.weekday === weekday && (p.hour > hour || (p.hour === hour && p.minute >= minute));
}
