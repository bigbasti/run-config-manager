import { EventEmitter } from 'events';
import * as cp from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import {
  NvmInstallerService,
  parseNvmVersion,
} from '../src/services/NvmInstallerService';

jest.mock('child_process');

describe('parseNvmVersion', () => {
  test('strips leading v', () => {
    expect(parseNvmVersion('v20.10.0')).toBe('20.10.0');
  });
  test('passes plain semver through', () => {
    expect(parseNvmVersion('18.19.1')).toBe('18.19.1');
  });
  test('trims surrounding whitespace', () => {
    expect(parseNvmVersion('  v22.3.0  ')).toBe('22.3.0');
  });
});

interface FakeChild extends EventEmitter {
  stdout: EventEmitter;
  stderr: EventEmitter;
  pid?: number;
  kill: jest.Mock;
}

function makeFakeChild(): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.pid = 4242;
  child.kill = jest.fn();
  return child;
}

describe('NvmInstallerService', () => {
  let spawnMock: jest.MockedFunction<typeof cp.spawn>;
  let statSpy: jest.SpiedFunction<typeof fs.promises.stat>;

  beforeEach(() => {
    spawnMock = cp.spawn as unknown as jest.MockedFunction<typeof cp.spawn>;
    spawnMock.mockReset();
    // Default: bin/node exists after install.
    statSpy = jest.spyOn(fs.promises, 'stat').mockResolvedValue({ isFile: () => true } as any);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  test('spawns bash -c "<source nvm.sh> && nvm install <version>"', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);

    const svc = new NvmInstallerService('/home/u/.nvm', '/home/u/.nvm/nvm.sh');
    const onProgress = jest.fn();
    const promise = svc.install('v20.10.0', onProgress);

    // Simulate nvm completing successfully after a couple of progress lines.
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from('Downloading and installing node v20.10.0...\n'));
      child.stderr.emit('data', Buffer.from('Computing checksum...\n'));
      child.emit('close', 0);
    });

    const result = await promise;

    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe('bash');
    expect(args).toEqual(['-c', '. "/home/u/.nvm/nvm.sh" && nvm install 20.10.0']);

    expect(onProgress).toHaveBeenCalledWith({
      state: 'installing',
      detail: 'Downloading and installing node v20.10.0...',
    });
    expect(onProgress).toHaveBeenCalledWith({
      state: 'installing',
      detail: 'Computing checksum...',
    });
    expect(result).toEqual({
      nodeHome: path.join('/home/u/.nvm', 'versions', 'node', 'v20.10.0'),
      version: 'v20.10.0',
    });
  });

  test('throws with the last lines of output on non-zero exit', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);

    const svc = new NvmInstallerService('/home/u/.nvm', '/home/u/.nvm/nvm.sh');
    const promise = svc.install('20.10.0', () => {});

    setImmediate(() => {
      child.stderr.emit('data', Buffer.from('curl: (22) The requested URL returned error: 404\n'));
      child.stderr.emit('data', Buffer.from('nvm: install 20.10.0 failed!\n'));
      child.emit('close', 5);
    });

    await expect(promise).rejects.toThrow(/exit 5/);
    await expect(promise).rejects.toThrow(/install 20.10.0 failed/);
  });

  test('throws when bin/node is missing after a "successful" install', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);
    statSpy.mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const svc = new NvmInstallerService('/home/u/.nvm', '/home/u/.nvm/nvm.sh');
    const promise = svc.install('v20.10.0', () => {});
    setImmediate(() => {
      child.emit('close', 0);
    });

    await expect(promise).rejects.toThrow(/no node binary/i);
  });

  test('cancel() sends SIGTERM and the install rejects with CancelledError', async () => {
    const child = makeFakeChild();
    spawnMock.mockReturnValue(child as unknown as cp.ChildProcess);

    const svc = new NvmInstallerService('/home/u/.nvm', '/home/u/.nvm/nvm.sh');
    const promise = svc.install('20.10.0', () => {});

    // Wait one tick so the spawn handler has wired up event listeners.
    await new Promise(setImmediate);
    svc.cancel();

    expect(child.kill).toHaveBeenCalledWith('SIGTERM');

    // Simulate the child eventually exiting after the signal.
    child.emit('close', 143); // SIGTERM exit code

    await expect(promise).rejects.toThrow(/cancel/i);
  });

  test('cancel() is safe with no install in flight', () => {
    const svc = new NvmInstallerService('/home/u/.nvm', '/home/u/.nvm/nvm.sh');
    expect(() => svc.cancel()).not.toThrow();
  });
});
