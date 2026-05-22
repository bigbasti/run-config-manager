import * as net from 'net';

// Asks the OS for an unused TCP port by binding a listener to port 0,
// reading the assigned port, and immediately closing. The returned
// port is briefly free to bind elsewhere — there's an inherent race,
// but for IDE-side child-process JMX it's the same race every other
// JVM monitoring tool (VisualVM, IntelliJ, JConsole) accepts.
//
// `exclude` — ports to never return (e.g. the app's own HTTP port).
// If the OS hands back an excluded port, we retry up to `maxAttempts`
// times before giving up. In practice this covers the TOCTOU case where
// the OS happens to return the same port the Spring Boot app wants to
// bind for its HTTP server, which causes "Port already in use" failures.
export async function allocateFreePort(exclude: number[] = [], maxAttempts = 10): Promise<number> {
  const excluded = new Set(exclude.filter(p => p > 0));
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const port = await probeOnce();
    if (!excluded.has(port)) return port;
  }
  // All attempts landed on an excluded port — extremely unlikely; give up.
  throw new Error(`Could not allocate a free port that avoids ${[...excluded].join(', ')} after ${maxAttempts} attempts`);
}

function probeOnce(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on('error', (e) => {
      try { srv.close(); } catch { /* ignore */ }
      reject(e);
    });
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      if (!addr || typeof addr === 'string') {
        srv.close();
        reject(new Error('listen(0) returned no address'));
        return;
      }
      const port = addr.port;
      srv.close(() => resolve(port));
    });
  });
}
