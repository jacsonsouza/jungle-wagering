import type { IntegrationEventEnvelope } from './integration-event.js';
import { FailureCode } from '../failures/failure-code.js';
import { DomainError } from '../shared/domain-error.js';

export type IntegrationEventFactory = (
  envelope: IntegrationEventEnvelope,
) => IntegrationEventLike;

/** Minimal contract the registry needs — avoids a circular dependency. */
export interface IntegrationEventLike {
  readonly eventType: string;
  readonly version: number;
  toJSON(): IntegrationEventEnvelope;
}

export class UnknownIntegrationEventTypeError extends DomainError {
  readonly code = FailureCode.InvalidMessageState;
}

const REGISTRY = new Map<string, IntegrationEventFactory>();

export function registerIntegrationEvent(
  eventType: string,
  version: number,
  factory: IntegrationEventFactory,
): void {
  REGISTRY.set(registryKey(eventType, version), factory);
}

export function resolveIntegrationEvent(
  eventType: string,
  version: number,
): IntegrationEventFactory {
  const factory = REGISTRY.get(registryKey(eventType, version));

  if (!factory) {
    throw new UnknownIntegrationEventTypeError(
      'no registered event for type and version',
      {
        eventType,
        version,
      },
    );
  }

  return factory;
}

export function clearIntegrationEventRegistry(): void {
  REGISTRY.clear();
}

function registryKey(eventType: string, version: number): string {
  return `${eventType}@${version}`;
}
