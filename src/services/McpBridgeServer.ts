import * as net from 'net';
import { log } from '../utils/logger';
import {
  createFrameDecoder,
  encodeFrame,
  BridgeRequest,
  BridgeResponse,
} from '../mcp/protocol';
import type { BridgeServices } from '../mcp/bridgeServices';

// Loopback request/response server. Mirrors NodeMonitoringService's transport
// shape (127.0.0.1:0, OS-assigned port) but is request/response rather than a
// one-way stream. Every request must carry the shared token or it is rejected
// before dispatch.
export class McpBridgeServer {
  private server: net.Server | null = null;
  private port = 0;
  private listenPromise?: Promise<number>;

  constructor(
    private readonly token: string,
    private readonly services: BridgeServices,
  ) {}

  listenPort(): Promise<number> {
    if (this.server && this.port) return Promise.resolve(this.port);
    if (this.listenPromise) return this.listenPromise;
    this.server = net.createServer(sock => this.onConnection(sock));
    this.server.on('error', e => log.warn(`MCP bridge server error: ${e.message}`));
    this.listenPromise = new Promise<number>((resolve, reject) => {
      this.server!.once('error', reject);
      this.server!.listen(0, '127.0.0.1', () => {
        const addr = this.server!.address();
        this.port = addr && typeof addr === 'object' ? addr.port : 0;
        log.info(`MCP bridge listening on 127.0.0.1:${this.port}`);
        resolve(this.port);
      });
    });
    return this.listenPromise;
  }

  private onConnection(sock: net.Socket): void {
    sock.setEncoding('utf8');
    const decode = createFrameDecoder<BridgeRequest>();
    sock.on('data', chunk => {
      for (const req of decode(String(chunk))) void this.handle(req, sock);
    });
    sock.on('error', () => { /* client disconnects are normal */ });
  }

  private async handle(req: BridgeRequest, sock: net.Socket): Promise<void> {
    const reply = (res: BridgeResponse) => {
      try { sock.write(encodeFrame(res)); } catch { /* socket closed */ }
    };
    if (req.token !== this.token) {
      reply({ id: req.id, ok: false, error: 'unauthorized' });
      return;
    }
    try {
      const result = await this.dispatch(req.method, req.params);
      reply({ id: req.id, ok: true, result });
    } catch (e) {
      reply({ id: req.id, ok: false, error: (e as Error).message });
    }
  }

  private dispatch(method: string, params: unknown): Promise<unknown> | unknown {
    const p = (params ?? {}) as {
      id?: string;
      config?: unknown;
      workspaceFolder?: string;
      monitor?: boolean;
      sections?: string[];
      tid?: number;
    };
    switch (method) {
      case 'list': return this.services.listConfigs();
      case 'get': return this.services.getConfig(String(p.id));
      case 'currentConfigs': return this.services.currentConfigs();
      case 'validate': return this.services.validateConfig(p.config);
      case 'create': return this.services.createConfig({ config: p.config, workspaceFolder: p.workspaceFolder });
      case 'update': return this.services.updateConfig(p.config);
      case 'delete': return this.services.deleteConfig(String(p.id));
      case 'run': return this.services.runConfig(String(p.id), p.monitor);
      case 'debug': return this.services.debugConfig(String(p.id), p.monitor);
      case 'stop': return this.services.stopConfig(String(p.id));
      case 'runStatus': return this.services.runStatus(String(p.id));
      case 'monitoringSnapshot': return this.services.monitoringSnapshot(String(p.id), p.sections);
      case 'threadDump': return this.services.threadDump(String(p.id), Number(p.tid));
      default: throw new Error(`unknown method: ${method}`);
    }
  }

  dispose(): void {
    if (this.server) {
      try { this.server.close(); } catch { /* ignore */ }
      this.server = null;
    }
  }
}
