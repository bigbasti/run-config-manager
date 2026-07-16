// Environment variables the extension passes to the spawned MCP server process.
export const MCP_PORT_ENV = 'RCM_MCP_PORT';
export const MCP_TOKEN_ENV = 'RCM_MCP_TOKEN';
export const MCP_GUIDE_PATH_ENV = 'RCM_MCP_GUIDE_PATH';

export type BridgeMethod =
  | 'list'
  | 'get'
  | 'currentConfigs'
  | 'validate'
  | 'create'
  | 'update'
  | 'delete'
  | 'run'
  | 'debug'
  | 'stop'
  | 'runStatus'
  | 'monitoringSnapshot'
  | 'threadDump';

export interface BridgeRequest {
  id: number;
  token: string;
  method: BridgeMethod;
  params?: unknown;
}

export type BridgeResponse =
  | { id: number; ok: true; result: unknown }
  | { id: number; ok: false; error: string };

// The loopback channel is newline-delimited JSON. One JSON document per line.
export function encodeFrame(msg: BridgeRequest | BridgeResponse): string {
  return JSON.stringify(msg) + '\n';
}

// Returns a stateful decoder that buffers partial input and yields complete
// messages as they arrive. Handles multiple messages per chunk and messages
// split across chunks.
export function createFrameDecoder<T>(): (chunk: string) => T[] {
  let buf = '';
  return (chunk: string): T[] => {
    buf += chunk;
    const out: T[] = [];
    let idx: number;
    while ((idx = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, idx);
      buf = buf.slice(idx + 1);
      if (line.trim()) out.push(JSON.parse(line) as T);
    }
    return out;
  };
}
