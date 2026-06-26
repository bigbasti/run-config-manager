import * as net from 'net';
import * as path from 'path';
import { Uri } from 'vscode';
import { NodeMonitoringService } from '../src/services/NodeMonitoringService';

const repoRoot = path.resolve(__dirname, '..');

function hello(id: string, pid = 111) {
  return JSON.stringify({ type: 'hello', t: Date.now(), id, pid, ppid: 1,
    nodeVersion: 'v20.0.0', v8Version: '11.3', platform: 'darwin', arch: 'arm64',
    execPath: '/usr/bin/node', cwd: '/app', argv: ['node', 'x'], env: {}, startTime: Date.now() }) + '\n';
}
function metrics(over: Record<string, number> = {}) {
  return JSON.stringify({ type: 'metrics', t: Date.now(), rss: 5e7, heapTotal: 2e7,
    heapUsed: 1e7, heapLimit: 2e9, external: 0, arrayBuffers: 0, cpuPercent: 3.2, uptime: 1,
    activeHandles: 4, activeRequests: 0, loopLagMean: 1, loopLagP50: 1, loopLagP99: 2, loopLagMax: 3, ...over }) + '\n';
}
function connectClient(port: number): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    const s = net.connect(port, '127.0.0.1', () => resolve(s));
    s.on('error', reject);
  });
}
const tick = () => new Promise(r => setTimeout(r, 30));

describe('NodeMonitoringService', () => {
  let svc: NodeMonitoringService;
  afterEach(() => svc?.dispose());

  test('routes hello+metrics to the expecting config and goes live', async () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    const port = await svc.listenPort();
    svc.expect('cfg1');
    const c = await connectClient(port);
    c.write(hello('cfg1')); c.write(metrics({ heapUsed: 12345678 }));
    await tick();
    const st = svc.state('cfg1');
    expect(st?.status).toBe('live');
    expect(st?.pid).toBe(111);
    expect(st?.history.length).toBe(1);
    expect(st?.history[0].heapUsed).toBe(12345678);
    expect(st?.hello?.nodeVersion).toBe('v20.0.0');
  });

  test('caps history at 60 ticks', async () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    const port = await svc.listenPort();
    svc.expect('cfg1');
    const c = await connectClient(port);
    c.write(hello('cfg1'));
    for (let i = 0; i < 65; i++) c.write(metrics());
    await tick();
    expect(svc.state('cfg1')!.history.length).toBe(60);
  });

  test('first connection wins; a second agent for the same id is dropped', async () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    const port = await svc.listenPort();
    svc.expect('cfg1');
    const c1 = await connectClient(port);
    c1.write(hello('cfg1', 111)); c1.write(metrics());
    await tick();
    const c2 = await connectClient(port);
    c2.write(hello('cfg1', 222)); c2.write(metrics());
    await tick();
    expect(svc.state('cfg1')!.pid).toBe(111); // still the first agent
  });

  test('detach removes state and rejects pending snapshots', async () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    const port = await svc.listenPort();
    svc.expect('cfg1');
    const c = await connectClient(port);
    c.write(hello('cfg1'));
    await tick();
    const p = svc.saveHeapSnapshot('cfg1', '/tmp/x.heapsnapshot').catch(e => e.message);
    svc.detach('cfg1');
    expect(await p).toMatch(/detached/);
    expect(svc.state('cfg1')).toBeUndefined();
  });

  test('socket close flips status to lost', async () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    const port = await svc.listenPort();
    svc.expect('cfg1');
    const c = await connectClient(port);
    c.write(hello('cfg1')); c.write(metrics());
    await tick();
    c.destroy();
    await tick();
    expect(svc.state('cfg1')!.status).toBe('lost');
  });

  test('agentPath points at the bundled cjs', () => {
    svc = new NodeMonitoringService(Uri.file(repoRoot));
    expect(svc.agentPath.endsWith(path.join('media', 'agent', 'rcm-node-agent.cjs'))).toBe(true);
  });
});
