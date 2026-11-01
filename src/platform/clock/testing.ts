import type { Clock } from "./index";

/**
 * TEST DOUBLE — must never be imported by production code
 * (dependency-cruiser rule `no-testing-doubles-in-production`).
 */
export class ManualClock implements Clock {
  private current: number;

  constructor(start: Date | string | number = "2026-01-01T00:00:00.000Z") {
    this.current = new Date(start).getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("advance(ms) requires a non-negative finite number");
    this.current += ms;
  }

  set(to: Date | string | number): void {
    this.current = new Date(to).getTime();
  }
}
