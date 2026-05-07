// The version of the run-config-manager extension itself, read from
// the bundled package.json. We use it for two things:
//   - Stamping `RunFile.version` on save so the next load knows which
//     migrations (if any) to run.
//   - Telling the migration runner what the "current" version is, so
//     it can pick every registered migration whose target ≤ this.
//
// Read once at module load — the package.json doesn't change at
// runtime. We could also pull it from VS Code's extension API, but
// require()-ing the bundled JSON keeps this file usable from the
// migration tests too (no vscode mock required).

// eslint-disable-next-line @typescript-eslint/no-var-requires
const pkg = require('../../package.json') as { version?: string };

// Fallback to "0.0.0" so a misconfigured build doesn't blow up at
// startup; in practice package.json always has a version.
export const EXTENSION_VERSION: string = pkg.version ?? '0.0.0';
