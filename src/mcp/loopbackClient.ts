import * as net from 'net';
import {
  createFrameDecoder,
  encodeFrame,
  BridgeMethod,
  BridgeRequest,
  BridgeResponse,
} from './protocol';

// Client used by the MCP server process to call back into the extension host.
// One persistent connection; requests are correlated by a monotonic id.
export class LoopbackClient {
  private socket: net.Socket | null = null;
  private connectPromise?: Promise<net.Socket>;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private decode = createFrameDecoder<BridgeResponse>();

  constructor(private readonly port: number, private readonly token: string) {}

  private ensure(): Promise<net.Socket> {
    if (this.socket) return Promise.resolve(this.socket);
    if (this.connectPromise) return this.connectPromise;
    this.connectPromise = new Promise<net.Socket>((resolve, reject) => {
      const sock = net.createConnection({ host: '127.0.0.1', port: this.port }, () => {
        this.socket = sock;
        resolve(sock);
      });
      sock.setEncoding('utf8');
      sock.on('data', chunk => {
        for (const res of this.decode(String(chunk))) {
          const p = this.pending.get(res.id);
          if (!p) continue;
          this.pending.delete(res.id);
          if (res.ok) p.resolve(res.result);
          else p.reject(new Error(res.error));
        }
      });
      sock.on('error', e => {
        this.socket = null;
        this.connectPromise = undefined;
        reject(e);
        for (const p of this.pending.values()) p.reject(e);
        this.pending.clear();
      });
      sock.on('close', () => {
        this.socket = null;
        this.connectPromise = undefined;
      });
    });
    return this.connectPromise;
  }

  async call(method: BridgeMethod, params?: unknown): Promise<unknown> {
    const sock = await this.ensure();
    const id = this.nextId++;
    const req: BridgeRequest = { id, token: this.token, method, params };
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      sock.write(encodeFrame(req));
    });
  }

  dispose(): void {
    if (this.socket) {
      try { this.socket.destroy(); } catch { /* ignore */ }
      this.socket = null;
    }
  }
}
