// Minimal vscode mock for Jest. Add to it as tests require more surface.

export class Uri {
  constructor(public readonly scheme: string, public readonly fsPath: string) {}
  static file(path: string): Uri {
    return new Uri('file', path);
  }
  static joinPath(base: Uri, ...parts: string[]): Uri {
    const joined = [base.fsPath, ...parts].join('/').replace(/\/+/g, '/');
    return new Uri(base.scheme, joined);
  }
  toString(): string {
    return `${this.scheme}://${this.fsPath}`;
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
      if (!fsStore.has(uri.fsPath)) throw new FsStubError('FileNotFound', uri.fsPath);
      return { type: FileType.File, size: fsStore.get(uri.fsPath)!.byteLength, ctime: 0, mtime: 0 };
    },
    async delete(uri: Uri): Promise<void> {
      fsStore.delete(uri.fsPath);
    },
    async rename(a: Uri, b: Uri): Promise<void> {
      const data = fsStore.get(a.fsPath);
      if (!data) throw new FsStubError('FileNotFound', a.fsPath);
      fsStore.set(b.fsPath, data);
      fsStore.delete(a.fsPath);
    },
  },
  workspaceFolders: [] as Array<{ uri: Uri; name: string; index: number }>,
  getWorkspaceFolder: (_: Uri) => undefined,
  createFileSystemWatcher: (_: string) => ({
    onDidChange: () => ({ dispose: () => {} }),
    onDidCreate: () => ({ dispose: () => {} }),
    onDidDelete: () => ({ dispose: () => {} }),
    dispose: () => {},
  }),
};

export const window = {
  showErrorMessage: jest.fn(),
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

export const tasks = {
  executeTask: jest.fn(),
  onDidEndTask: jest.fn().mockReturnValue({ dispose: () => {} }),
  onDidStartTask: jest.fn().mockReturnValue({ dispose: () => {} }),
  onDidEndTaskProcess: jest.fn().mockReturnValue({ dispose: () => {} }),
};

export const debug = {
  startDebugging: jest.fn(),
  stopDebugging: jest.fn(),
  onDidStartDebugSession: jest.fn().mockReturnValue({ dispose: () => {} }),
  onDidTerminateDebugSession: jest.fn().mockReturnValue({ dispose: () => {} }),
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
  constructor(public id: string) {}
}

export const RelativePattern = class {
  constructor(public base: any, public pattern: string) {}
};
