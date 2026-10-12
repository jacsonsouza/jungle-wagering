import {
  Entity,
  Index,
  PrimaryKey,
  Property,
} from '@mikro-orm/decorators/legacy';

@Entity({ tableName: 'outbox_messages' })
@Index({
  name: 'idx_outbox_due',
  expression:
    'create index idx_outbox_due on outbox_messages (next_attempt_at) where published_at is null',
})
export class OutboxMessageEntity {
  @PrimaryKey({ type: 'uuid' })
  id!: string;

  @Property({ type: 'varchar', length: 64, fieldName: 'aggregate_id' })
  aggregateId!: string;

  @Property({ type: 'varchar', length: 128, fieldName: 'event_type' })
  eventType!: string;

  @Property({ type: 'jsonb' })
  payload!: Record<string, unknown>;

  @Property({ type: 'timestamptz', fieldName: 'occurred_at' })
  occurredAt!: Date;

  @Property({ type: 'int' })
  attempts!: number;

  @Property({
    type: 'timestamptz',
    fieldName: 'next_attempt_at',
    nullable: true,
  })
  nextAttemptAt?: Date;

  @Property({
    type: 'timestamptz',
    fieldName: 'published_at',
    nullable: true,
  })
  publishedAt?: Date;
}
