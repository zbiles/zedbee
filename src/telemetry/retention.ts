/** Shared by the event outbox and its detail files so both expire together. */
export const TELEMETRY_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
export const TELEMETRY_MAX_QUEUED_EVENTS = 100;
export const TELEMETRY_MAX_QUEUE_BYTES = 256 * 1024;
