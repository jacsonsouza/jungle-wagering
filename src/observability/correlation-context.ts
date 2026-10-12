import { AsyncLocalStorage } from 'node:async_hooks';

const storage = new AsyncLocalStorage<string>();

export function runWithCorrelationId<T>(id: string, fn: () => T): T {
  return storage.run(id, fn);
}

export function correlationId(): string | undefined {
  return storage.getStore();
}
