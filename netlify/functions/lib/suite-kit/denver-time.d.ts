export declare const DENVER_TZ = "America/Denver";
export interface DenverParts {
    year: number;
    month: number;
    day: number;
    hour: number;
    minute: number;
    second: number;
    /** 0 = Sunday … 6 = Saturday, in Denver. */
    weekday: number;
    /** Minutes east of UTC: -360 in MDT, -420 in MST. */
    offsetMinutes: number;
}
/** The Denver wall-clock reading of an instant. */
export declare function denverParts(at?: Date | number | string): DenverParts;
/** The Denver calendar date, "2026-10-17". */
export declare function denverDate(at?: Date | number | string): string;
/** True while Denver keeps daylight time (MDT, UTC-6). */
export declare function isDenverDst(at?: Date | number | string): boolean;
/** Wall-clock time with its offset, e.g. "2026-10-01T09:00:00-06:00" (the shape Lofty's task API takes). */
export declare function denverIso(at?: Date | number | string): string;
/**
 * The instant at which Denver's clock reads this wall time. A time skipped by spring-forward moves one
 * hour later (2:30 AM → 3:30 AM MDT); a time repeated by fall-back is the first one (MDT).
 */
export declare function denverWallTime(year: number, month: number, day: number, hour?: number, minute?: number, second?: number): Date;
/** Midnight at the start of this instant's Denver day. */
export declare function startOfDenverDay(at?: Date | number | string): Date;
/** The Denver calendar date `days` after this instant's (negative for before), "2026-10-18". */
export declare function addDenverDays(at: Date | number | string, days: number): string;
/** The two instants Denver's clocks change in a year: spring forward (to MDT) and fall back (to MST). */
export declare function denverDstChanges(year: number): {
    springForward: Date;
    fallBack: Date;
};
/** True when the instant falls on this Denver weekday (0 = Sunday) at or after hh:mm Denver time. */
export declare function isDenverWeekdayAtOrAfter(at: Date | number | string, weekday: number, hour: number, minute?: number): boolean;
