import { redact, scrubString } from "./redact";
import type { RedactOptions } from "./redact";

export { redact, scrubString, REDACTED } from "./redact";
export type { RedactOptions } from "./redact";

/**
 * Minimal structured logger (no dependency, P-8): one JSON object per line. EVERY field and message
 * passes through redact() before it is written, and the logger never throws.
 * Call configureLogger() once at process start (web / worker); the default is 'info' to stdout.
 */
export type LogLevel = "debug" | "info" | "warn" | "error";
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface LogSink {
  write(line: string): void;
}

export interface Logger {
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface LoggerOptions extends RedactOptions {
  level?: LogLevel;
  sink?: LogSink;
  now?: () => Date;
}

const stdoutSink: LogSink = {
  write: (line) => {
    process.stdout.write(`${line}\n`);
  },
};

export function createLogger(options: LoggerOptions = {}): Logger {
  const level = options.level ?? "info";
  const sink = options.sink ?? stdoutSink;
  const now = options.now ?? (() => new Date());
  const emit = (lvl: LogLevel, message: string, fields?: Record<string, unknown>): void => {
    if (ORDER[lvl] < ORDER[level]) return;
    try {
      const record = {
        time: now().toISOString(),
        level: lvl,
        msg: scrubString(String(message), options),
        ...(fields ? { fields: redact(fields, options) } : {}),
      };
      sink.write(JSON.stringify(record));
    } catch {
      // logging must never break the caller
    }
  };
  return {
    debug: (m, f) => emit("debug", m, f),
    info: (m, f) => emit("info", m, f),
    warn: (m, f) => emit("warn", m, f),
    error: (m, f) => emit("error", m, f),
  };
}

let current: Logger = createLogger();

export function configureLogger(options: LoggerOptions): void {
  current = createLogger(options);
}

export function getLogger(): Logger {
  return current;
}
