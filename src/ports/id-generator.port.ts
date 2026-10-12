import { randomUUID } from 'node:crypto';

/**
 * Ids are generated through a port so tests can hand out deterministic,
 * readable ids — which keeps assertions (and failure reports) sane.
 */
export interface IdGeneratorPort {
  newId(): string;
}

export class UuidGenerator implements IdGeneratorPort {
  newId(): string {
    return randomUUID();
  }
}
