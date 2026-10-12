import type { OutboxMessage } from '../domain/index.js';
import type { OutboxMessageEntity } from '../entities/outbox-message.entity.js';

export class OutboxMapper {
  static toPersistence(
    message: OutboxMessage,
    entity: OutboxMessageEntity,
  ): OutboxMessageEntity {
    entity.id = message.id;
    entity.aggregateId = message.aggregateId;
    entity.eventType = message.eventType;
    entity.payload = message.payload;
    entity.occurredAt = message.occurredAt;
    entity.attempts = message.attempts;
    entity.nextAttemptAt = message.nextAttemptAt;
    entity.publishedAt = message.publishedAt;

    return entity;
  }
}
