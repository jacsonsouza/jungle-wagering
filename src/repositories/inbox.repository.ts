import { randomUUID } from 'node:crypto';
import type { EntityManager } from '@mikro-orm/core';
import type { InboxMessage } from '../domain/index.js';
import type { InboxRepositoryPort } from '../ports/inbox-repository.port.js';
import { InboxMessageEntity } from '../entities/inbox-message.entity.js';

export class MikroOrmInboxRepository implements InboxRepositoryPort {
  async insert(tx: EntityManager, message: InboxMessage): Promise<void> {
    const entity = new InboxMessageEntity();

    // The surrogate key is a persistence detail; the dedupe key is
    // (consumerName, messageId) and lives on the unique index. Generating the
    // PK here rather than in the domain keeps `InboxMessage` free of ids it
    // never reads.
    entity.id = randomUUID();
    entity.consumerName = message.consumerName;
    entity.messageId = message.messageId;
    entity.payloadHash = message.payloadHash;
    entity.receivedAt = message.receivedAt;
    entity.processedAt = message.processedAt;

    await tx.persist(entity).flush();
  }
}
