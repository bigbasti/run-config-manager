// Test-only augmentation of the `vscode` module to expose helpers from our Jest mock.
// The real Jest mock lives in __mocks__/vscode.ts — see jest.config.js moduleNameMapper.
import type { Uri, EventEmitter } from 'vscode';

declare module 'vscode' {
  export const __resetFs: () => void;
  export const __writeFs: (path: string, data: string | Uint8Array) => void;
  export const __readFs: (path: string) => string | undefined;
  export const __watchers: Array<{
    pattern: unknown;
    change: EventEmitter<Uri>;
    create: EventEmitter<Uri>;
    del: EventEmitter<Uri>;
  }>;
  export const __resetWatchers: () => void;
  // NativeRunnerService helpers.
  export const __setLaunchConfig: (
    folderKey: string,
    data: { configurations?: unknown[]; compounds?: unknown[] },
  ) => void;
  export const __resetLaunchConfig: () => void;
  export const __setFetchableTasks: (tasks: unknown[]) => void;
  export const __resetFetchableTasks: () => void;
}
