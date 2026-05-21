import * as path from 'path';
import { runCommand } from './detectGos';

// Spawns `<goHome>/bin/go version` and extracts the semver string.
// Returns undefined when the binary is missing, unresponsive, or the
// output doesn't match the expected format.
export async function probeGoVersion(goHome: string): Promise<string | undefined> {
  const bin = process.platform === 'win32'
    ? path.join(goHome, 'bin', 'go.exe')
    : path.join(goHome, 'bin', 'go');

  // `go version` prints: "go version go1.22.3 darwin/arm64"
  const out = await runCommand(bin, ['version'], 4000);
  if (!out) return undefined;
  const m = out.match(/go version go(\d+\.\d+(?:\.\d+)?)/);
  return m ? m[1] : undefined;
}
