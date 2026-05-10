import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export interface NvmInstall {
  available: boolean;
  // Absolute path to NVM_DIR (the directory containing nvm.sh).
  // Only populated when available === true.
  nvmDir?: string;
  // Absolute path to nvm.sh inside nvmDir. Only populated when available === true.
  nvmShPath?: string;
}

// POSIX-only nvm probe. Resolution order:
//   1. $NVM_DIR/nvm.sh, if NVM_DIR is set and the file exists.
//   2. $HOME/.nvm/nvm.sh, the standard install location.
// Returns { available: false } on Windows or if neither location resolves.
//
// Two fs.stat calls in the worst case. Cheap enough to call on every
// dialog open — no caching needed at this layer.
export async function detectNvm(): Promise<NvmInstall> {
  if (process.platform === 'win32') {
    // nvm-windows is a separate tool with a different binary and command
    // surface. Out of scope for this detector — Windows users get the
    // standalone tarball download path instead.
    return { available: false };
  }

  const candidates: string[] = [];
  if (process.env.NVM_DIR) candidates.push(process.env.NVM_DIR);
  candidates.push(path.join(os.homedir(), '.nvm'));

  for (const dir of candidates) {
    const sh = path.join(dir, 'nvm.sh');
    if (await isFile(sh)) {
      return { available: true, nvmDir: dir, nvmShPath: sh };
    }
  }
  return { available: false };
}

async function isFile(p: string): Promise<boolean> {
  try {
    const stat = await fs.promises.stat(p);
    return stat.isFile();
  } catch {
    return false;
  }
}
