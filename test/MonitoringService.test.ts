import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as vscode from 'vscode';
import { MonitoringService } from '../src/services/MonitoringService';

jest.mock('child_process');

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  stdin: { write: jest.Mock; end: jest.Mock };
  pid?: number;
  kill: jest.Mock;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { write: jest.fn(), end: jest.fn() };
  child.pid = 4242;
  child.kill = jest.fn();
  return child;
}

describe('MonitoringService', () => {
  let spawnMock: jest.MockedFunction<typeof cp.spawn>;
  let extensionUri: vscode.Uri;

  beforeEach(() => {
    spawnMock = cp.spawn as unknown as jest.MockedFunction<typeof cp.spawn>;
    spawnMock.mockReset();
    extensionUri = vscode.Uri.file('/ext');
  });

  test('attach() spawns the agent jar with the expected args', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('java');
    expect(args).toContain('-jar');
    expect(args!.some(a => a.endsWith('rcm-monitor.jar'))).toBe(true);
    expect(args).toContain('39000');
  });

  test('parses metrics line and fires onChanged', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    const fired: string[] = [];
    svc.onChanged(id => fired.push(id));

    svc.attach('cfg-id', 1234, 39000);
    child.stdout.emit('data', Buffer.from(
      '{"type":"metrics","t":1000,"heapUsed":1024,"heapCommitted":2048,"heapMax":4096,"nonHeapUsed":512,"cpuLoad":0.05,"threadCount":12,"gcCount":3,"gcTime":50}\n',
    ));
    await new Promise(r => setImmediate(r));

    const state = svc.state('cfg-id')!;
    expect(state.history).toHaveLength(1);
    expect((state.history[0] as any).heapUsed).toBe(1024);
    expect(fired).toContain('cfg-id');
  });

  test('handles partial line buffering', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    // Split a single message across two chunks.
    child.stdout.emit('data', Buffer.from('{"type":"metrics","t":1,"heapUs'));
    child.stdout.emit('data', Buffer.from('ed":7,"heapCommitted":7,"heapMax":7,"nonHeapUsed":0,"cpuLoad":0.0,"threadCount":1,"gcCount":0,"gcTime":0}\n'));
    await new Promise(r => setImmediate(r));
    const state = svc.state('cfg-id')!;
    expect(state.history).toHaveLength(1);
    expect((state.history[0] as any).heapUsed).toBe(7);
  });

  test('caps the history ring buffer at 60 entries', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    for (let i = 0; i < 70; i++) {
      child.stdout.emit('data', Buffer.from(
        `{"type":"metrics","t":${i},"heapUsed":${i},"heapCommitted":0,"heapMax":0,"nonHeapUsed":0,"cpuLoad":0,"threadCount":1,"gcCount":0,"gcTime":0}\n`,
      ));
    }
    await new Promise(r => setImmediate(r));
    const state = svc.state('cfg-id')!;
    expect(state.history).toHaveLength(60);
    expect((state.history[0] as any).t).toBe(10); // first 10 dropped
    expect((state.history[59] as any).t).toBe(69);
  });

  test('detach() kills the agent and clears state', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    svc.detach('cfg-id');
    expect(child.kill).toHaveBeenCalled();
    expect(svc.state('cfg-id')).toBeUndefined();
  });

  test('attach() is idempotent for the same configId', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    svc.attach('cfg-id', 5678, 39001); // ignored — same id, already attached
    expect(spawnMock).toHaveBeenCalledTimes(1);
  });

  test('error message flips status to lost', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    child.stdout.emit('data', Buffer.from('{"type":"error","message":"connect failed"}\n'));
    await new Promise(r => setImmediate(r));
    const state = svc.state('cfg-id')!;
    expect(state.status).toBe('lost');
  });

  test('saveHeapDump writes "dump <path>" to agent stdin', () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    const svc = new MonitoringService(extensionUri);
    svc.attach('cfg-id', 1234, 39000);
    void svc.saveHeapDump('cfg-id', '/tmp/heap.hprof');
    expect(child.stdin.write).toHaveBeenCalledWith('dump /tmp/heap.hprof\n');
  });
});
