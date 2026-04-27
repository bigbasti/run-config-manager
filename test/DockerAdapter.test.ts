import { Uri, workspace } from 'vscode';
import { DockerAdapter } from '../src/adapters/docker/DockerAdapter';
import type { DockerService, ContainerSummary, ContainerInfo } from '../src/services/DockerService';

// Thin fake for the DockerService — enough surface to exercise the adapter's
// schema-shaping logic without running the real CLI.
class FakeDockerService {
  private _list: ContainerSummary[] = [];
  private _avail: boolean | undefined = true;
  private _err: string | undefined = undefined;
  private _inspect: Record<string, ContainerInfo> = {};
  seedList(list: ContainerSummary[]) { this._list = list; }
  seedInspect(id: string, info: ContainerInfo) { this._inspect[id] = info; }
  setAvailable(v: boolean | undefined, err?: string) { this._avail = v; this._err = err; }
  list() { return this._list; }
  isAvailable() { return this._avail; }
  listError() { return this._err; }
  isRunning(id: string) { return this._list.find(c => c.id === id)?.state === 'running'; }
  find(id: string) { return this._list.find(c => c.id.startsWith(id) || id.startsWith(c.id)); }
  async inspect(id: string) { return this._inspect[id] ?? null; }
  async refresh() { /* no-op */ }
  async startContainer() { /* no-op */ }
  async stopContainer() { /* no-op */ }
  showLogs() { /* no-op */ }
  onChanged = () => ({ dispose: () => {} });
  dispose() { /* no-op */ }
  start() { /* no-op */ }
}

function mkSummary(over: Partial<ContainerSummary> = {}): ContainerSummary {
  return {
    id: 'abc123def456789012345678901234567890',
    name: 'test-container',
    image: 'nginx:latest',
    state: 'running',
    status: 'Up 1 hour',
    ports: '0.0.0.0:8080->80/tcp',
    ...over,
  };
}

describe('DockerAdapter', () => {
  let fake: FakeDockerService;
  let adapter: DockerAdapter;

  beforeEach(() => {
    (workspace as any).workspaceFolders = [{ uri: Uri.file('/ws'), name: 'ws', index: 0 }];
    fake = new FakeDockerService();
    adapter = new DockerAdapter(fake as unknown as DockerService);
  });

  test('getFormSchema: running container appears in "Running" group', () => {
    fake.seedList([mkSummary({ id: 'r1', name: 'running-one', state: 'running' })]);
    const schema = adapter.getFormSchema({ containers: fake.list() });
    const containerField = schema.typeSpecific.find(f => f.key === 'typeOptions.containerId');
    expect(containerField?.kind).toBe('selectOrCustom');
    if (containerField?.kind === 'selectOrCustom') {
      expect(containerField.options).toHaveLength(1);
      expect(containerField.options[0].group).toBe('Running');
      expect(containerField.options[0].value).toBe('r1');
    }
  });

  test('getFormSchema: stopped containers go into "Stopped / other" group', () => {
    fake.seedList([
      mkSummary({ id: 's1', name: 'stopped', state: 'exited', status: 'Exited (0) 1 minute ago' }),
      mkSummary({ id: 'r1', name: 'running', state: 'running' }),
    ]);
    const schema = adapter.getFormSchema({ containers: fake.list() });
    const containerField = schema.typeSpecific.find(f => f.key === 'typeOptions.containerId');
    if (containerField?.kind === 'selectOrCustom') {
      // Running first due to sort
      expect(containerField.options[0].value).toBe('r1');
      expect(containerField.options[0].group).toBe('Running');
      expect(containerField.options[1].value).toBe('s1');
      expect(containerField.options[1].group).toBe('Stopped / other');
    }
  });

  test('getFormSchema: daemon unreachable → warning banner in info panel', () => {
    const schema = adapter.getFormSchema({
      containers: [],
      dockerAvailable: false,
      dockerError: 'Cannot connect',
    });
    const info = schema.typeSpecific.find(f => f.key === 'typeOptions.containerInfo');
    expect(info?.kind).toBe('info');
    if (info?.kind === 'info') {
      expect(info.content.banner?.kind).toBe('warning');
      expect(info.content.banner?.text).toContain('Cannot connect');
    }
  });

  test('getFormSchema: no selection → muted "pick a container" banner', () => {
    fake.seedList([mkSummary({ id: 'r1' })]);
    const schema = adapter.getFormSchema({ containers: fake.list() });
    const info = schema.typeSpecific.find(f => f.key === 'typeOptions.containerInfo');
    if (info?.kind === 'info') {
      expect(info.content.banner?.kind).toBe('muted');
    }
  });

  test('getFormSchema: selected container with info renders ports and volumes', () => {
    const info: ContainerInfo = {
      id: 'r1' + '0'.repeat(56),
      name: 'web',
      image: 'nginx:1.25',
      state: 'running',
      created: '2026-01-01T00:00:00Z',
      ports: [{ host: '0.0.0.0:8080', container: '80', protocol: 'tcp' }],
      volumes: [{ source: '/data', destination: '/var/www', mode: 'rw' }],
      env: ['NODE_ENV=production'],
      raw: {},
    };
    const schema = adapter.getFormSchema({
      containers: [mkSummary({ id: 'r1', name: 'web' })],
      selectedContainerId: 'r1',
      selectedContainerInfo: info,
    });
    const infoField = schema.typeSpecific.find(f => f.key === 'typeOptions.containerInfo');
    if (infoField?.kind === 'info') {
      expect(infoField.content.banner?.kind).toBe('running');
      const portList = infoField.content.lists?.find(l => l.label === 'Ports');
      expect(portList?.items).toContain('0.0.0.0:8080 → 80/tcp');
      const volList = infoField.content.lists?.find(l => l.label === 'Volumes');
      expect(volList?.items).toContain('/data → /var/www [rw]');
    }
  });

  test('buildCommand is a harmless stub — actual start/stop goes through extension.ts', () => {
    const r = adapter.buildCommand(
      { id: 'x', name: 'x', type: 'docker', projectPath: '', workspaceFolder: '', env: {}, programArgs: '', vmArgs: '',
        typeOptions: { containerId: 'r1' } } as any,
    );
    // The command is never actually executed; make sure we don't throw.
    expect(typeof r.command).toBe('string');
    expect(Array.isArray(r.args)).toBe(true);
  });
});
