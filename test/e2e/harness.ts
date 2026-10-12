import { randomUUID } from 'node:crypto';
import { INestApplication } from '@nestjs/common';
import { Test, TestingModule } from '@nestjs/testing';
import request from 'supertest';
import type { App } from 'supertest/types.js';
import { AppModule } from '../../src/app.module.js';
import { CurrencyCode, WagerTransactionKind } from '../../src/domain/index.js';
import { closeTestOrm, truncateAllTables } from '../setup/orm.js';

/**
 * Shared harness for the HTTP contract suite: lifecycle, request helpers.
 *
 * The suite proves the half of the stack the integration tests cannot reach —
 * everything between a request and a use case: the `ValidationPipe`, the
 * global exception filter, the no-op auth guard, the presenters, and above all
 * the §9 status mapping, which exists so a provider never has to parse error
 * text to decide whether resending is safe. Real PostgreSQL via `AppModule`;
 * nothing in the stack is replaced.
 *
 * The lifecycle is exported rather than registered at import time, so a spec
 * opts in visibly and does not depend on Vitest re-evaluating this module for
 * its setup to run.
 */

let app: INestApplication<App>;

/** Boots the Nest stack. Register in a spec's `beforeAll`. */
export async function bootApp(): Promise<void> {
  const moduleFixture: TestingModule = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();

  app = moduleFixture.createNestApplication();
  await app.init();
}

/** Closes the app, then the pooled connections behind it. */
export async function closeApp(): Promise<void> {
  await app.close();
  await closeTestOrm();
}

/** Every spec starts from an empty database. */
export async function resetDatabase(): Promise<void> {
  await truncateAllTables();
}

// ---- helpers ----------------------------------------------------------------

export function http() {
  return request(app.getHttpServer());
}

interface WalletView {
  readonly id: string;
  readonly playerId: string;
  readonly balance: { readonly amount: string; readonly currency: string };
  readonly version: number;
}

export async function givenWallet(
  initialAmount = '100.00',
): Promise<WalletView> {
  const response = await http()
    .post('/wallets')
    .send({
      playerId: randomUUID(),
      initialBalance: { amount: initialAmount, currency: CurrencyCode.BRL },
    })
    .expect(201);

  return response.body as WalletView;
}

/** §9's recommended default, so a test only overrides what it is about. */
export function submission(
  wallet: WalletView,
  overrides: Record<string, unknown> = {},
) {
  return {
    providerId: 'provider-a',
    externalTransactionId: `ext-${randomUUID()}`,
    playerId: wallet.playerId,
    walletId: wallet.id,
    roundId: 'round-987',
    gameId: 'fortune-chimp',
    kind: WagerTransactionKind.Bet,
    money: { amount: '25.00', currency: CurrencyCode.BRL },
    ...overrides,
  };
}

export function errorCode(response: request.Response): unknown {
  return (response.body as { error: { code: string } }).error.code;
}
