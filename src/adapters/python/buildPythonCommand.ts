import * as path from 'path';
import type { RunConfig } from '../../shared/types';
import { splitArgs } from '../npm/splitArgs';

export function buildPythonCommand(cfg: RunConfig): { command: string; args: string[] } {
  if (cfg.type !== 'python') throw new Error('PythonAdapter received non-python config');
  const to = cfg.typeOptions;

  const command = pythonBin(to.pythonPath);
  const interpreterArgs = splitArgs(cfg.vmArgs ?? '');
  const programArgs = splitArgs(cfg.programArgs ?? '');

  switch (to.launchMode) {
    case 'script':
      return { command, args: [...interpreterArgs, to.scriptPath, ...programArgs] };
    case 'module':
      return { command, args: [...interpreterArgs, '-m', to.moduleName, ...programArgs] };
    case 'framework':
      return {
        command,
        args: [...interpreterArgs, ...frameworkInvocation(to.framework, to.frameworkCommand), ...programArgs],
      };
    case 'pytest':
      return { command, args: [...interpreterArgs, '-m', 'pytest', ...splitArgs(to.pytestArgs)] };
    case 'custom':
      return { command, args: [...interpreterArgs, ...splitArgs(to.customArgs)] };
  }
}

function pythonBin(pythonHome: string): string {
  if (!pythonHome) return 'python3';
  if (process.platform === 'win32') return path.join(pythonHome, 'python.exe');
  return path.join(pythonHome, 'bin', 'python3');
}

// Maps framework + command into a -m invocation. 'django' / 'uvicorn' /
// 'gunicorn' / 'celery' / 'flask' all support `-m`. fastapi / starlette /
// typer / click are libraries; the user is expected to use script or
// module mode for those, so we treat them as a pass-through to -m as well.
function frameworkInvocation(framework: string, command: string): string[] {
  const cmdArgs = splitArgs(command);
  if (!framework) return cmdArgs;
  return ['-m', framework, ...cmdArgs];
}
