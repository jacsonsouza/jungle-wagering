import {
  bootApp,
  closeApp,
  givenWallet,
  http,
  resetDatabase,
  submission,
} from './harness.js';

beforeAll(bootApp);
afterAll(closeApp);
beforeEach(resetDatabase);

describe('Operational endpoints', () => {
  it('answers liveness without touching the network', async () => {
    const response = await http().get('/health/live').expect(200);

    expect(response.body).toMatchObject({ status: 'ok' });
  });

  it('reports readiness of every dependency', async () => {
    const response = await http().get('/health/ready').expect(200);

    expect(response.body).toMatchObject({ status: 'ok' });
    expect(
      (response.body as { dependencies: unknown[] }).dependencies.length,
    ).toBeGreaterThan(0);
  });

  it('exposes Prometheus in the format a scraper expects', async () => {
    // prom-client registers a series on its FIRST observation, so an empty
    // registry would say nothing about whether the metrics work.
    const wallet = await givenWallet();
    await http()
      .post('/wagering/transactions')
      .set('Idempotency-Key', 'provider-a:for-metrics')
      .send(submission(wallet, { externalTransactionId: 'for-metrics' }))
      .expect(200);

    const response = await http()
      .get('/metrics')
      .expect(200)
      .expect('Content-Type', /text\/plain/);

    // §12's headline series, with the low-cardinality label.
    expect(response.text).toContain('transactions_total{status="PROCESSED"}');
    expect(response.text).toContain('wallet_lock_wait_seconds');
  });
});
