import {
  Uri, Task,
  __setLaunchConfig, __resetLaunchConfig,
  __setFetchableTasks, __resetFetchableTasks,
  workspace,
} from 'vscode';
import { NativeRunnerService } from '../src/services/NativeRunnerService';
import {
  NativeLaunchContentProvider,
  launchViewUri,
  taskViewUri,
} from '../src/ui/NativeLaunchContentProvider';

const folderA = { uri: Uri.file('/ws/a'), name: 'a', index: 0 };

describe('NativeLaunchContentProvider', () => {
  let svc: NativeRunnerService;
  let provider: NativeLaunchContentProvider;

  beforeEach(() => {
    __resetLaunchConfig();
    __resetFetchableTasks();
    (workspace as any).workspaceFolders = [folderA];
    svc = new NativeRunnerService();
    provider = new NativeLaunchContentProvider(svc);
  });

  afterEach(() => {
    svc.dispose();
    (workspace as any).workspaceFolders = [];
  });

  test('renders launch config JSON with header', async () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      configurations: [{ name: 'Run API', type: 'node', request: 'launch', program: '${workspaceFolder}/server.js' }],
    });
    const uri = launchViewUri(folderA.uri.fsPath, 'Run API');
    const text = await provider.provideTextDocumentContent(uri);
    expect(text).toMatch(/Launch configuration/);
    expect(text).toContain('"name": "Run API"');
    expect(text).toContain('"type": "node"');
  });

  test('appends dependent task and launch sections for compounds', async () => {
    __setLaunchConfig(folderA.uri.fsPath, {
      configurations: [
        { name: 'Run API', type: 'node', request: 'launch', preLaunchTask: 'build' },
        { name: 'Attach', type: 'node', request: 'attach' },
      ],
      compounds: [
        { name: 'All', configurations: ['Run API', 'Attach'], preLaunchTask: 'precheck' },
      ],
    });
    const uri = launchViewUri(folderA.uri.fsPath, 'All');
    const text = await provider.provideTextDocumentContent(uri);
    expect(text).toMatch(/Compound configuration/);
    expect(text).toContain('Dependencies referenced by this launch config');
    expect(text).toContain('"name": "Run API"');
    expect(text).toContain('"name": "Attach"');
    expect(text).toMatch(/Task: "precheck"/);
  });

  test('renders task content for a workspace task', async () => {
    const task = new Task(
      { type: 'shell' },
      folderA,
      'build',
      'Workspace',
      {},
    );
    __setFetchableTasks([task]);
    // Populate tasks.json so renderTask's tasksJson lookup finds the label.
    await workspace.fs.writeFile(
      Uri.joinPath(folderA.uri, '.vscode', 'tasks.json'),
      new TextEncoder().encode(JSON.stringify({ tasks: [{ label: 'build', type: 'shell', command: 'make' }] })),
    );
    // Rebuild the service so getTasks re-reads tasks.json.
    svc.dispose();
    svc = new NativeRunnerService();
    provider = new NativeLaunchContentProvider(svc);
    const uri = taskViewUri(folderA.uri.fsPath, 'Workspace', 'build');
    const text = await provider.provideTextDocumentContent(uri);
    expect(text).toContain('Task — a');
    expect(text).toContain('"label": "build"');
  });

  test('gives a helpful message when the launch disappeared', async () => {
    const uri = launchViewUri(folderA.uri.fsPath, 'Nope');
    const text = await provider.provideTextDocumentContent(uri);
    expect(text).toMatch(/not found/i);
  });

  test('folderKey with path separators survives Uri round-trip', async () => {
    // Regression: encodeURIComponent('/git/zebra') → %2Fgit%2Fzebra, which
    // VS Code's Uri.path canonicalisation decodes back to slashes, breaking
    // the per-segment split. Query-string payload avoids that.
    __setLaunchConfig('/deep/path/to/workspace', {
      configurations: [{ name: 'Run', type: 'node', request: 'launch' }],
    });
    // Simulate a folder at the deep path so getLaunches returns something.
    (workspace as any).workspaceFolders = [
      { uri: Uri.file('/deep/path/to/workspace'), name: 'workspace', index: 0 },
    ];
    svc.dispose();
    svc = new NativeRunnerService();
    provider = new NativeLaunchContentProvider(svc);
    const uri = launchViewUri('/deep/path/to/workspace', 'Run');
    const text = await provider.provideTextDocumentContent(uri);
    expect(text).toContain('"name": "Run"');
    expect(text).not.toMatch(/not found/i);
  });
});
