import {
  failureCategory,
  FailureCategory,
  FailureCode,
} from '../failures/failure-code.js';

export interface DomainErrorJson {
  readonly name: string;
  readonly code: FailureCode;
  readonly category: FailureCategory;
  readonly message: string;
  readonly details: Readonly<Record<string, unknown>>;
}

export abstract class DomainError extends Error {
  abstract readonly code: FailureCode;

  readonly details: Readonly<Record<string, unknown>>;

  constructor(
    message: string,
    details: Readonly<Record<string, unknown>> = {},
  ) {
    super(message);
    this.name = new.target.name;
    this.details = Object.freeze({ ...details });
    Object.setPrototypeOf(this, new.target.prototype);
  }

  get category(): FailureCategory {
    return failureCategory(this.code);
  }

  toJSON(): DomainErrorJson {
    return {
      name: this.name,
      code: this.code,
      category: this.category,
      message: this.message,
      details: this.details,
    };
  }
}

export function isDomainError(error: unknown): error is DomainError {
  return error instanceof DomainError;
}
