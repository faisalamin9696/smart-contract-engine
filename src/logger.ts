import type { LogLevel } from './config';

const LEVELS: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

export interface Logger {
  debug(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

/**
 * Tiny structured logger (JSON lines). Kept dependency free so the engine can be
 * embedded anywhere; swap for pino/winston by implementing {@link Logger}.
 */
export class ConsoleLogger implements Logger {
  constructor(
    private readonly level: LogLevel = 'info',
    private readonly bindings: Record<string, unknown> = {},
  ) {}

  private write(level: LogLevel, msg: string, meta?: Record<string, unknown>): void {
    if (LEVELS[level] < LEVELS[this.level]) return;
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      level,
      msg,
      ...this.bindings,
      ...(meta ?? {}),
    });
    if (level === 'error') process.stderr.write(line + '\n');
    else process.stdout.write(line + '\n');
  }

  debug(msg: string, meta?: Record<string, unknown>): void {
    this.write('debug', msg, meta);
  }
  info(msg: string, meta?: Record<string, unknown>): void {
    this.write('info', msg, meta);
  }
  warn(msg: string, meta?: Record<string, unknown>): void {
    this.write('warn', msg, meta);
  }
  error(msg: string, meta?: Record<string, unknown>): void {
    this.write('error', msg, meta);
  }
  child(bindings: Record<string, unknown>): Logger {
    return new ConsoleLogger(this.level, { ...this.bindings, ...bindings });
  }
}

export const nullLogger: Logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => nullLogger,
};
