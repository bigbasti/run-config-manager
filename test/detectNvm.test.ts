import { detectNvm } from '../src/adapters/npm/detectNvm';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

describe('detectNvm', () => {
  let savedNvmDir: string | undefined;
  let savedPlatform: NodeJS.Platform;

  beforeEach(() => {
    savedNvmDir = process.env.NVM_DIR;
    savedPlatform = process.platform;
    delete process.env.NVM_DIR;
  });

  afterEach(() => {
    if (savedNvmDir === undefined) delete process.env.NVM_DIR;
    else process.env.NVM_DIR = savedNvmDir;
    Object.defineProperty(process, 'platform', { value: savedPlatform });
    jest.restoreAllMocks();
  });

  test('returns available=false on Windows without checking the filesystem', async () => {
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const statSpy = jest.spyOn(fs.promises, 'stat');
    const result = await detectNvm();
    expect(result).toEqual({ available: false });
    expect(statSpy).not.toHaveBeenCalled();
  });

  test('uses NVM_DIR/nvm.sh when env var is set and file exists', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.NVM_DIR = '/custom/nvm';
    jest.spyOn(fs.promises, 'stat').mockImplementation(async (p: any) => {
      if (p === path.join('/custom/nvm', 'nvm.sh')) return { isFile: () => true } as any;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await detectNvm();
    expect(result).toEqual({
      available: true,
      nvmDir: '/custom/nvm',
      nvmShPath: path.join('/custom/nvm', 'nvm.sh'),
    });
  });

  test('falls back to ~/.nvm/nvm.sh when NVM_DIR is unset', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    const home = os.homedir();
    const expectedDir = path.join(home, '.nvm');
    const expectedSh = path.join(expectedDir, 'nvm.sh');
    jest.spyOn(fs.promises, 'stat').mockImplementation(async (p: any) => {
      if (p === expectedSh) return { isFile: () => true } as any;
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await detectNvm();
    expect(result).toEqual({
      available: true,
      nvmDir: expectedDir,
      nvmShPath: expectedSh,
    });
  });

  test('returns available=false when nvm.sh is absent at every probe location', async () => {
    Object.defineProperty(process, 'platform', { value: 'linux' });
    process.env.NVM_DIR = '/custom/nvm';
    jest.spyOn(fs.promises, 'stat').mockImplementation(async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    const result = await detectNvm();
    expect(result).toEqual({ available: false });
  });
});
