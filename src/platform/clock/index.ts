/** Time source port. All expiry/lease logic receives time from a Clock so it is testable (P-6). */
export interface Clock {
  now(): Date;
}

export const systemClock: Clock = {
  now: () => new Date(),
};
