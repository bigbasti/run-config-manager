import { ExecutionService } from '../src/services/ExecutionService';
import { AdapterRegistry } from '../src/adapters/AdapterRegistry';
import { NpmAdapter } from '../src/adapters/npm/NpmAdapter';
import * as PortScanner from '../src/services/PortScanner';

jest.mock('../src/services/PortScanner', () => ({
  scanPorts: jest.fn().mockResolvedValue([]),
  killProcess: jest.fn().mockResolvedValue(undefined),
  inferConfigPortsDetailed: jest.fn().mockReturnValue({ explicit: [], defaultPorts: [] }),
}));

const scanPorts = PortScanner.scanPorts as jest.MockedFunction<typeof PortScanner.scanPorts>;
const inferConfigPortsDetailed =
  PortScanner.inferConfigPortsDetailed as jest.MockedFunction<typeof PortScanner.inferConfigPortsDetailed>;

function portRow(port: number): PortScanner.PortEntry {
  return { port, address: '127.0.0.1', pid: 999, processName: 'node', protocol: 'tcp' };
}

// A non-spring/quarkus/npm type so resolveExpectedPorts uses only the
// (mocked) inferConfigPortsDetailed and does no project-file probing.
const cfg = {
  id: 'cfg1',
  name: 'X',
  type: 'custom-command',
  projectPath: '.',
  typeOptions: { command: 'sleep 100' },
} as unknown as Parameters<ExecutionService['waitForShutdown']>[0];

const folder = { uri: { fsPath: '/tmp/proj' }, name: 'proj', index: 0 } as any;

describe('ExecutionService.waitForShutdown', () => {
  let svc: ExecutionService;

  beforeEach(() => {
    scanPorts.mockReset().mockResolvedValue([]);
    inferConfigPortsDetailed.mockReset().mockReturnValue({ explicit: [], defaultPorts: [] } as any);
    const reg = new AdapterRegistry();
    reg.register(new NpmAdapter());
    svc = new ExecutionService(reg);
  });

  test('polls until the expected port is released, then resolves', async () => {
    inferConfigPortsDetailed.mockReturnValue({ explicit: [8080], defaultPorts: [] } as any);
    // First scan: port still bound. Second scan: freed.
    scanPorts
      .mockResolvedValueOnce([portRow(8080)])
      .mockResolvedValue([]);

    await svc.waitForShutdown(cfg, folder, 0);

    // At least two scans: one that saw the port, one that saw it free.
    expect(scanPorts.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test('with no known ports, resolves without scanning ports', async () => {
    inferConfigPortsDetailed.mockReturnValue({ explicit: [], defaultPorts: [] } as any);
    await svc.waitForShutdown(cfg, folder, 0);
    expect(scanPorts).not.toHaveBeenCalled();
  });

  test('applies the settle delay after the port frees', async () => {
    inferConfigPortsDetailed.mockReturnValue({ explicit: [8080], defaultPorts: [] } as any);
    scanPorts.mockResolvedValue([]); // already free
    const start = Date.now();
    await svc.waitForShutdown(cfg, folder, 120);
    expect(Date.now() - start).toBeGreaterThanOrEqual(100);
  });
});
