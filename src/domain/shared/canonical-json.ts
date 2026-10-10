import { FailureCode } from '../failures/failure-code.js';
import { DomainError } from './domain-error.js';

class CanonicalJsonError extends DomainError {
  readonly code = FailureCode.CanonicalJsonUnsupported;
}

export function canonicalJson(value: unknown): string {
  return serialize(value);
}

function serialize(value: unknown): string {
  if (value === null) return 'null';

  switch (typeof value) {
    case 'string':
      return JSON.stringify(value);
    case 'boolean':
      return value ? 'true' : 'false';
    case 'number': {
      if (!Number.isFinite(value)) {
        throw new CanonicalJsonError(
          'canonical JSON supports finite numbers only',
          { value: String(value) },
        );
      }
      return JSON.stringify(value);
    }
    case 'object': {
      if (Array.isArray(value)) {
        return `[${value
          .map((item) => {
            if (item === undefined) {
              throw new CanonicalJsonError(
                'undefined inside array is not canonicalizable',
              );
            }
            return serialize(item);
          })
          .join(',')}]`;
      }
      const record = value as Record<string, unknown>;
      const keys = Object.keys(record).sort(compareByCodeUnit);
      const pairs = keys.map((key) => {
        const entry = record[key];
        if (entry === undefined) {
          throw new CanonicalJsonError(
            'undefined property is not canonicalizable',
            { key },
          );
        }
        return `${JSON.stringify(key)}:${serialize(entry)}`;
      });
      return `{${pairs.join(',')}}`;
    }
    default:
      throw new CanonicalJsonError('unsupported value in canonical payload', {
        type: typeof value,
      });
  }
}

/**
 * Sorts by UTF-16 code unit (localeCompare is forbidden — it varies by OS
 * locale). Exported so the equality path can be unit-tested; Object.keys()
 * never exercises it because object keys are unique.
 */
export function compareByCodeUnit(a: string, b: string): number {
  if (a < b) return -1;
  if (a > b) return 1;
  return 0;
}
