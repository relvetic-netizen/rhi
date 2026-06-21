/**
 * Structured JSON logger.
 * Outputs to stderr (stdout reserved for MCP protocol).
 */

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

const LOG_LEVEL_NAMES: Record<LogLevel, string> = {
  [LogLevel.DEBUG]: "DEBUG",
  [LogLevel.INFO]: "INFO",
  [LogLevel.WARN]: "WARN",
  [LogLevel.ERROR]: "ERROR",
};

function parseLogLevel(val: string | undefined): LogLevel {
  switch (val?.toUpperCase()) {
    case "DEBUG": return LogLevel.DEBUG;
    case "WARN": return LogLevel.WARN;
    case "ERROR": return LogLevel.ERROR;
    default: return LogLevel.INFO;
  }
}

const globalLevel = parseLogLevel(process.env.LOG_LEVEL);

export class Logger {
  constructor(private component: string) {}

  debug(msg: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, msg, data);
  }
  info(msg: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, msg, data);
  }
  warn(msg: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, msg, data);
  }
  error(msg: string, data?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, msg, data);
  }

  private log(level: LogLevel, msg: string, data?: Record<string, unknown>): void {
    if (level < globalLevel) return;
    const entry = {
      ts: new Date().toISOString(),
      level: LOG_LEVEL_NAMES[level],
      component: this.component,
      msg,
      ...data,
    };
    process.stderr.write(JSON.stringify(entry) + "\n");
  }
}

export function createLogger(component: string): Logger {
  return new Logger(component);
}

export function getErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
