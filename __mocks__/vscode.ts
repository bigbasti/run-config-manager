// Minimal vscode mock for Jest. Add to it as tests require more surface.

export class Uri {
  constructor(
    public readonly scheme: string,
    public readonly fsPath: string,
    public readonly path: string = fsPath,
    public readonly query: string = '',
  ) {}
  static file(path: string): Uri {
    return new Uri('file', path, path);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    const joined = [base.fsPath, ...parts].join('/').replace(/\/+/g, '/');
    return new Uri(base.scheme, joined, joined);
  }
  static parse(raw: string): Uri {
    const m = /^([a-zA-Z0-9-]+):([^?]*)(?:\?(.*))?$/.exec(raw);
    if (!m) throw new Error(`Uri.parse failed: ${raw}`);
    const [, scheme, pathPart, queryPart = ''] = m;
    const path = pathPart.startsWith('//') ? pathPart.replace(/^\/+/, '/') : pathPart;
    return new Uri(scheme, path, path, queryPart);
  }
  toString(): string {
    return `${this.scheme}:${this.path}${this.query ? `?${this.query}` : ''}`;
  }
  with(_: any): Uri {
    return this;
  }
}

type Listener<T> = (e: T) => any;

export class EventEmitter<T> {
  private listeners: Listener<T>[] = [];
  event = (l: Listener<T>) => {
    this.listeners.push(l);
    return { dispose: () => { this.listeners = this.listeners.filter(x => x !== l); } };
  };
  fire(e: T) {
    for (const l of this.listeners) l(e);
  }
  dispose() {
    this.listeners = [];
  }
}

// In-memory FS backing for tests
const fsStore = new Map<string, Uint8Array>();

// Registered watchers so tests can trigger events.
export const __watchers: Array<{
  pattern: any;
  change: EventEmitter<Uri>;
  create: EventEmitter<Uri>;
  del: EventEmitter<Uri>;
}> = [];
export const __resetWatchers = () => { __watchers.length = 0; };

export const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 } as const;

class FsStubError extends Error {
  constructor(public code: string, msg: string) { super(msg); }
}

export const __resetFs = () => { fsStore.clear(); };
export const __writeFs = (path: string, data: string | Uint8Array) => {
  fsStore.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data);
};
export const __readFs = (path: string): string | undefined => {
  const b = fsStore.get(path);
  return b ? new TextDecoder().decode(b) : undefined;
};

// In-memory backing for workspace.getConfiguration('launch'). Keyed by folder
// fsPath; each entry holds configurations + compounds arrays. Tests populate
// via __setLaunchConfig.
const launchBySection = new Map<string, { configurations: any[]; compounds: any[] }>();
export const __setLaunchConfig = (folderKey: string, data: { configurations?: any[]; compounds?: any[] }) => {
  launchBySection.set(folderKey, {
    configurations: data.configurations ?? [],
    compounds: data.compounds ?? [],
  });
};
export const __resetLaunchConfig = () => { launchBySection.clear(); };

export const workspace = {
  fs: {
    async readFile(uri: Uri): Promise<Uint8Array> {
      const data = fsStore.get(uri.fsPath);
      if (!data) throw new FsStubError('FileNotFound', uri.fsPath);
      return data;
    },
    async writeFile(uri: Uri, content: Uint8Array): Promise<void> {
      fsStore.set(uri.fsPath, content);
    },
    async stat(uri: Uri) {
      if (fsStore.has(uri.fsPath)) {
        return { type: FileType.File, size: fsStore.get(uri.fsPath)!.byteLength, ctime: 0, mtime: 0 };
      }
      // Treat the path as a directory if any file exists under it.
      const prefix = uri.fsPath.endsWith('/') ? uri.fsPath : uri.fsPath + '/';
      for (const p of fsStore.keys()) {
        if (p.startsWith(prefix)) {
          return { type: FileType.Directory, size: 0, ctime: 0, mtime: 0 };
        }
      }
      throw new FsStubError('FileNotFound', uri.fsPath);
    },
    async delete(uri: Uri): Promise<void> {
      fsStore.delete(uri.fsPath);
    },
    async rename(a: Uri, b: Uri, _opts?: { overwrite?: boolean }): Promise<void> {
      const data = fsStore.get(a.fsPath);
      if (!data) throw new FsStubError('FileNotFound', a.fsPath);
      fsStore.set(b.fsPath, data);
      fsStore.delete(a.fsPath);
    },
    async readDirectory(uri: Uri): Promise<Array<[string, number]>> {
      // Enumerate files whose fsPath is a direct child of `uri.fsPath`.
      const prefix = uri.fsPath.endsWith('/') ? uri.fsPath : uri.fsPath + '/';
      const directChildren = new Map<string, number>();
      for (const path of fsStore.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        if (!rest) continue;
        const slash = rest.indexOf('/');
        if (slash === -1) {
          directChildren.set(rest, FileType.File);
        } else {
          directChildren.set(rest.slice(0, slash), FileType.Directory);
        }
      }
      if (directChildren.size === 0) {
        // Match real VS Code behavior for a non-existent dir.
        throw new FsStubError('FileNotFound', uri.fsPath);
      }
      return Array.from(directChildren.entries());
    },
  },
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  getWorkspaceFolder: (_: Uri) => undefined,
  getConfiguration: (section: string, scope?: { fsPath?: string }) => {
    const folderKey = scope?.fsPath;
    if (section === 'launch' && folderKey) {
      const entry = launchBySection.get(folderKey) ?? { configurations: [], compounds: [] };
      return {
        get: (key: string) => {
          if (key === 'configurations') return entry.configurations;
          if (key === 'compounds') return entry.compounds;
          return undefined;
        },
      };
    }
    return { get: () => undefined };
  },
  registerTextDocumentContentProvider: jest.fn(() => ({ dispose: () => {} })),
  createFileSystemWatcher: (pattern: any) => {
    const change = new EventEmitter<Uri>();
    const create = new EventEmitter<Uri>();
    const del = new EventEmitter<Uri>();
    __watchers.push({ pattern, change, create, del });
    return {
      onDidChange: change.event,
      onDidCreate: create.event,
      onDidDelete: del.event,
      dispose: () => {},
    };
  },
};

export const window = {
  showErrorMessage: jest.fn(),
  showWarningMessage: jest.fn(),
  showInformationMessage: jest.fn(),
  showOpenDialog: jest.fn(),
  showQuickPick: jest.fn(),
  showWorkspaceFolderPick: jest.fn(),
  createOutputChannel: (_name: string) => ({
    appendLine: jest.fn(),
    append: jest.fn(),
    show: jest.fn(),
    dispose: jest.fn(),
  }),
  createTreeView: jest.fn(),
  createWebviewPanel: jest.fn(),
};

export const commands = {
  registerCommand: jest.fn().mockReturnValue({ dispose: () => {} }),
  executeCommand: jest.fn(),
};

const endEmitter = new EventEmitter<{ execution: any }>();
const startEmitter = new EventEmitter<{ execution: any }>();

// fetchTasks() returns whatever the test provisioned. Keeps tests hermetic.
let fetchableTasks: any[] = [];
export const __setFetchableTasks = (list: any[]) => { fetchableTasks = list; };
export const __resetFetchableTasks = () => { fetchableTasks = []; };

export const tasks = {
  executeTask: jest.fn(async (task: any) => {
    const execution = {
      task,
      terminate: jest.fn(() => { endEmitter.fire({ execution }); }),
    };
    startEmitter.fire({ execution });
    return execution;
  }),
  fetchTasks: jest.fn(async () => fetchableTasks),
  onDidStartTask: startEmitter.event,
  onDidEndTask: endEmitter.event,
  onDidEndTaskProcess: new EventEmitter<any>().event,
  __endEmitter: endEmitter,
  __startEmitter: startEmitter,
};

const debugStart = new EventEmitter<any>();
const debugTerm = new EventEmitter<any>();

export const debug = {
  startDebugging: jest.fn(async (_folder: any, config: any) => {
    debugStart.fire({ configuration: config, name: config.name });
    return true;
  }),
  stopDebugging: jest.fn(),
  onDidStartDebugSession: debugStart.event,
  onDidTerminateDebugSession: debugTerm.event,
  __startEmitter: debugStart,
  __termEmitter: debugTerm,
};

export class Task {
  constructor(
    public definition: any,
    public scope: any,
    public name: string,
    public source: string,
    public execution: any,
    public problemMatchers: any[] = [],
  ) {}
}

export class ShellExecution {
  constructor(public command: string, public args: any[] = [], public options: any = {}) {}
}

export class CustomExecution {
  constructor(public callback: () => Promise<any>) {}
}

export class TaskScope {
  static Workspace = 1;
  static Global = 2;
}

export enum TreeItemCollapsibleState {
  None = 0,
  Collapsed = 1,
  Expanded = 2,
}

export class TreeItem {
  contextValue?: string;
  description?: string;
  iconPath?: any;
  command?: any;
  tooltip?: string;
  constructor(public label: string, public collapsibleState: TreeItemCollapsibleState = TreeItemCollapsibleState.None) {}
}

export class ThemeIcon {
  constructor(public id: string, public color?: any) {}
}

export class ThemeColor {
  constructor(public id: string) {}
}

export class MarkdownString {
  value: string;
  constructor(value: string = '') { this.value = value; }
  appendMarkdown(v: string) { this.value += v; return this; }
  toString() { return this.value; }
}

export const RelativePattern = class {
  constructor(public base: any, public pattern: string) {}
};

export const extensions = {
  getExtension: jest.fn((_id: string) => undefined),
};
