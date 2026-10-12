import { LogFields, LoggerPort } from "../ports/logger.port.js";
import { correlationId } from "./correlation-context.js";

type Level = 'DEBUG' | 'INFO' | 'WARN' | 'ERROR';

const LEVEL_ORDER: Record<Level, number> = { DEBUG: 10, INFO: 20, WARN: 30, ERROR: 40 };

export class JsonLogger implements LoggerPort {
  constructor(
    private readonly service: string,
    private readonly minLevel: Level = 'INFO',
    private readonly sink: (line: string) => void = console.log,
  ) {}

  debug(message: string, fields?: LogFields): void { this.write('DEBUG', message, fields); }
  info(message: string, fields?: LogFields): void { this.write('INFO', message, fields); }
  warn(message: string, fields?: LogFields): void { this.write('WARN', message, fields); }

  error(message: string, fields?: LogFields, error?: unknown): void {
    this.write('ERROR', message, {
      ...fields,
      errorName: error instanceof Error ? error.name : undefined,
      errorMessage: error instanceof Error ? error.message : undefined,
    });
  }

  private write(level: Level, message: string, fields?: LogFields): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) return;

    const { correlationId: cid, ...rest } = fields ?? {};

    this.sink(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level,
        service: this.service,
        correlationId: cid ?? correlationId(),
        message,
        ...rest,
      }),
    );
  }
}
