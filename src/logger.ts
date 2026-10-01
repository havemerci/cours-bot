import { config } from "./config.js";

const levels = { debug: 10, info: 20, warn: 30, error: 40 } as const;
type Level = keyof typeof levels;

function write(level: Level, message: string, context?: unknown): void {
  if (levels[level] < levels[config.LOG_LEVEL]) return;

  const suffix = context === undefined ? "" : ` ${safeJson(context)}`;
  const line = `${new Date().toISOString()} ${level.toUpperCase()} ${message}${suffix}`;
  const output = level === "error" ? console.error : level === "warn" ? console.warn : console.log;
  output(line);
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export const logger = {
  debug: (message: string, context?: unknown) => write("debug", message, context),
  info: (message: string, context?: unknown) => write("info", message, context),
  warn: (message: string, context?: unknown) => write("warn", message, context),
  error: (message: string, context?: unknown) => write("error", message, context),
};
