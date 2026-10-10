export interface ReceiveInboxProps {
  readonly messageId: string;
  readonly consumerName: string;
  readonly payloadHash: string;
  readonly receivedAt: Date;
}

export interface InboxMessageState extends ReceiveInboxProps {
  readonly processedAt?: Date;
}

export class InboxMessage {
  private _processedAt?: Date;

  private constructor(
    public readonly messageId: string,
    public readonly consumerName: string,
    public readonly payloadHash: string,
    public readonly receivedAt: Date,
    processedAt?: Date,
  ) {
    this._processedAt = processedAt;
  }

  /** Dedupe lives in a (consumer_name, message_id) DB constraint — Phase 2. */
  static receive(props: ReceiveInboxProps): InboxMessage {
    return new InboxMessage(
      props.messageId,
      props.consumerName,
      props.payloadHash,
      new Date(props.receivedAt.getTime()),
    );
  }

  static rehydrate(state: InboxMessageState): InboxMessage {
    return new InboxMessage(
      state.messageId,
      state.consumerName,
      state.payloadHash,
      new Date(state.receivedAt.getTime()),
      state.processedAt ? new Date(state.processedAt.getTime()) : undefined,
    );
  }

  get processedAt(): Date | undefined {
    return this._processedAt
      ? new Date(this._processedAt.getTime())
      : undefined;
  }

  isProcessed(): boolean {
    return this._processedAt !== undefined;
  }

  /** Idempotent: reprocessing an already PROCESSED message is a no-op. */
  markProcessed(at: Date): void {
    if (this.isProcessed()) return;
    this._processedAt = new Date(at.getTime());
  }
}
