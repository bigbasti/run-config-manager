import { detectNodes, parseNodeVersion } from '../src/adapters/npm/detectNodes';

describe('parseNodeVersion', () => {
  test('strips leading v', () => {
    expect(parseNodeVersion('v20.10.0\n')).toBe('20.10.0');
  });
  test('returns undefined for empty / non-version output', () => {
    expect(parseNodeVersion('')).toBeUndefined();
    expect(parseNodeVersion('hello world')).toBeUndefined();
  });
  test('handles trailing whitespace and surrounding text', () => {
    expect(parseNodeVersion('  v18.19.1  ')).toBe('18.19.1');
  });
});

import * as fs from 'fs';
import * as path from 'path';

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    // Default: empty output (no `which node` hits) so detection falls
    // back to filesystem scans the test mocks directly.
    const ee = new (require('events').EventEmitter)();
    ee.stdout = new (require('events').EventEmitter)();
    ee.stderr = new (require('events').EventEmitter)();
    setImmediate(() => {
      ee.emit('close', 1);
    });
    return ee;
  }),
}));

describe('detectNodes (filesystem mocks)', () => {
  let realReaddir: typeof fs.promises.readdir;
  let realStat: typeof fs.promises.stat;
  let realRealpath: typeof fs.promises.realpath;
  let savedNodeHome: string | undefined;
  let savedNvmDir: string | undefined;

  beforeAll(() => {
    realReaddir = fs.promises.readdir;
    realStat = fs.promises.stat;
    realRealpath = fs.promises.realpath;
  });
  beforeEach(() => {
    savedNodeHome = process.env.NODE_HOME;
    savedNvmDir = process.env.NVM_DIR;
    delete process.env.NODE_HOME;
    delete process.env.NVM_DIR;
  });
  afterEach(() => {
    (fs.promises as any).readdir = realReaddir;
    (fs.promises as any).stat = realStat;
    (fs.promises as any).realpath = realRealpath;
    if (savedNodeHome === undefined) delete process.env.NODE_HOME;
    else process.env.NODE_HOME = savedNodeHome;
    if (savedNvmDir === undefined) delete process.env.NVM_DIR;
    else process.env.NVM_DIR = savedNvmDir;
  });

  test('picks up nvm-style installs and dedupes by realpath', async () => {
    const home = require('os').homedir();
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');

    (fs.promises as any).readdir = jest.fn(async (dir: string) => {
      if (dir === nvmDir) {
        return [
          { name: 'v20.10.0', isDirectory: () => true, isSymbolicLink: () => false },
          { name: 'v18.19.1', isDirectory: () => true, isSymbolicLink: () => false },
        ];
      }
      return [];
    });
    (fs.promises as any).stat = jest.fn(async (p: string) => {
      if (p.endsWith(path.join('bin', 'node')) || p.endsWith('node.exe')) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectNodes();
    expect(result).toEqual(expect.arrayContaining([
      path.join(nvmDir, 'v20.10.0'),
      path.join(nvmDir, 'v18.19.1'),
    ]));
  });

  test('dedupes installs that resolve to the same realpath', async () => {
    const home = require('os').homedir();
    const rcm = path.join(
      process.platform === 'win32'
        ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'rcm')
        : path.join(home, '.rcm'),
      'nodes',
    );
    (fs.promises as any).readdir = jest.fn(async (dir: string) => {
      if (dir === rcm) {
        return [
          { name: 'node-v20.10.0', isDirectory: () => true, isSymbolicLink: () => false },
          { name: 'node-v20-link', isDirectory: () => false, isSymbolicLink: () => true },
        ];
      }
      return [];
    });
    (fs.promises as any).stat = jest.fn(async () => ({ isFile: () => true }));
    (fs.promises as any).realpath = jest.fn(async (p: string) => {
      // Both children point to the same canonical path.
      return path.join(rcm, 'node-v20.10.0');
    });

    const result = await detectNodes();
    // Only one entry survives dedupe.
    const rcmEntries = result.filter(p => p.startsWith(rcm));
    expect(rcmEntries.length).toBe(1);
  });

  test('drops paths that lack the node binary', async () => {
    const home = require('os').homedir();
    const nvmDir = path.join(home, '.nvm', 'versions', 'node');
    (fs.promises as any).readdir = jest.fn(async (dir: string) => {
      if (dir === nvmDir) {
        return [{ name: 'v20.10.0', isDirectory: () => true, isSymbolicLink: () => false }];
      }
      return [];
    });
    (fs.promises as any).stat = jest.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectNodes();
    expect(result.filter(p => p.includes('.nvm'))).toEqual([]);
  });
});
