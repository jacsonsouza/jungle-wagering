export const PORTS = {
  unitOfWork: Symbol('UnitOfWork'),
  wallets: Symbol('WalletRepository'),
  wagerTransactions: Symbol('WagerTransactionRepository'),
  outbox: Symbol('OutboxRepository'),
  clock: Symbol('Clock'),
  ids: Symbol('IdGenerator'),
  logger: Symbol('Logger'),
  metrics: Symbol('Metrics'),
  healthChecks: Symbol('HealthChecks'),
  messageQueue: Symbol('MessageQueue'),
  inbox: Symbol('InboxRepository'),
} as const;
