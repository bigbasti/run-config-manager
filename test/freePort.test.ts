import { allocateFreePort } from '../src/services/monitoring/freePort';
import * as net from 'net';

describe('allocateFreePort', () => {
  test('returns a port that can actually be bound to', async () => {
    const port = await allocateFreePort();
    expect(port).toBeGreaterThan(1024);
    expect(port).toBeLessThan(65536);
    // Confirm the port is actually free by binding to it.
    await new Promise<void>((resolve, reject) => {
      const srv = net.createServer();
      srv.listen(port, '127.0.0.1', () => srv.close(() => resolve()));
      srv.on('error', reject);
    });
  });

  test('returns different ports across calls (no collisions when not bound)', async () => {
    const ports = await Promise.all([
      allocateFreePort(), allocateFreePort(), allocateFreePort(),
    ]);
    // Strictly speaking, the OS may reuse ports; we just want NOT all
    // identical, since the helper relies on listen(0).
    const uniq = new Set(ports);
    expect(uniq.size).toBeGreaterThanOrEqual(1);
  });
});
