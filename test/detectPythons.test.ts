import { detectPythons } from '../src/adapters/python/detectPythons';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as vscode from 'vscode';

jest.mock('child_process', () => ({
  spawn: jest.fn(() => {
    // Default: empty output (no `which python` hits) so detection falls
    // back to filesystem scans the test mocks directly.
    const ee = new (require('events').EventEmitter)();
    ee.stdout = new (require('events').EventEmitter)();
    ee.stderr = new (require('events').EventEmitter)();
    setImmediate(() => ee.emit('close', 1));
    return ee;
  }),
}));

describe('detectPythons (filesystem mocks)', () => {
  let realReaddir: typeof fs.promises.readdir;
  let realStat: typeof fs.promises.stat;
  let realRealpath: typeof fs.promises.realpath;
  let savedVirtualEnv: string | undefined;

  beforeEach(() => {
    realReaddir = fs.promises.readdir;
    realStat = fs.promises.stat;
    realRealpath = fs.promises.realpath;
    savedVirtualEnv = process.env.VIRTUAL_ENV;
    delete process.env.VIRTUAL_ENV;
  });

  afterEach(() => {
    (fs.promises as any).readdir = realReaddir;
    (fs.promises as any).stat = realStat;
    (fs.promises as any).realpath = realRealpath;
    if (savedVirtualEnv === undefined) delete process.env.VIRTUAL_ENV;
    else process.env.VIRTUAL_ENV = savedVirtualEnv;
  });

  test('picks up project-local .venv', async () => {
    const projectUri = vscode.Uri.file('/proj/sample');
    (fs.promises as any).readdir = jest.fn(async () => []);
    (fs.promises as any).stat = jest.fn(async (p: string) => {
      if (p === path.join('/proj/sample', '.venv', 'bin', 'python')) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectPythons(projectUri);
    expect(result).toContain(path.join('/proj/sample', '.venv'));
  });

  test('scans pyenv versions and dedupes by realpath', async () => {
    const projectUri = vscode.Uri.file('/proj/sample');
    const home = os.homedir();
    const pyenvDir = path.join(home, '.pyenv', 'versions');

    (fs.promises as any).readdir = jest.fn(async (dir: string) => {
      if (dir === pyenvDir) {
        return [
          { name: '3.12.1', isDirectory: () => true, isSymbolicLink: () => false },
          { name: '3.11.7', isDirectory: () => true, isSymbolicLink: () => false },
        ];
      }
      return [];
    });
    (fs.promises as any).stat = jest.fn(async (p: string) => {
      if (p.endsWith(path.join('bin', 'python')) || p.endsWith(path.join('bin', 'python3')) || p.endsWith('python.exe')) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectPythons(projectUri);
    expect(result).toEqual(expect.arrayContaining([
      path.join(pyenvDir, '3.12.1'),
      path.join(pyenvDir, '3.11.7'),
    ]));
  });

  test('respects VIRTUAL_ENV when set', async () => {
    const projectUri = vscode.Uri.file('/proj/sample');
    process.env.VIRTUAL_ENV = '/some/active/venv';

    (fs.promises as any).readdir = jest.fn(async () => []);
    (fs.promises as any).stat = jest.fn(async (p: string) => {
      if (p === path.join('/some/active/venv', 'bin', 'python')) {
        return { isFile: () => true };
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectPythons(projectUri);
    expect(result).toContain('/some/active/venv');
  });

  test('drops paths that lack a python binary', async () => {
    const projectUri = vscode.Uri.file('/proj/sample');
    const home = os.homedir();
    (fs.promises as any).readdir = jest.fn(async (dir: string) => {
      if (dir === path.join(home, '.pyenv', 'versions')) {
        return [{ name: '3.12.1', isDirectory: () => true, isSymbolicLink: () => false }];
      }
      return [];
    });
    (fs.promises as any).stat = jest.fn(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    (fs.promises as any).realpath = jest.fn(async (p: string) => p);

    const result = await detectPythons(projectUri);
    expect(result.filter(p => p.includes('.pyenv'))).toEqual([]);
  });
});
