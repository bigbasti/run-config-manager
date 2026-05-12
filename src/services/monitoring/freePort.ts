import * as net from 'net';

// Asks the OS for an unused TCP port by binding a listener to port 0,
// reading the assigned port, and immediately closing. The returned
// port is briefly free to bind elsewhere — there's an inherent race,
// but for IDE-side child-process JMX it's the same race every other
// JVM monitoring tool (VisualVM, IntelliJ, JConsole) accepts.
export async function allocateFreePort(): Promise<number> {
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
