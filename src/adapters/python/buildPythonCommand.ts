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

// Maps framework + command into a -m invocation.
//
// Direct `-m` targets (the framework name IS its module-runnable form):
//   django → `python -m django <subcmd>` (runserver, migrate, ...)
//   flask → `python -m flask <args>` (--app foo run)
//   uvicorn → `python -m uvicorn app:main`
//   gunicorn → `python -m gunicorn app:app -b ...`
//   celery → `python -m celery -A pkg worker`
//
// Library frameworks routed through uvicorn (the dominant ASGI server):
//   fastapi → `python -m uvicorn <command>` — fastapi the package isn't
//             a runnable module on older versions; uvicorn is the
//             standard runner.
//   starlette → same.
//
// CLI frameworks (typer / click) — these aren't run as `-m <fw>`; the
// user's command IS already the script invocation. Pass through verbatim.
//
// Empty framework: throw — running framework launchMode without a
// framework picked produces a nonsense invocation.
// Exported so buildCommandPreview can render the same `-m <target>`
// fragment the runtime will execute. Mirrors the routing rules below.
export const FRAMEWORK_M_TARGET: Record<string, string | null> = {
  django: 'django',
  flask: 'flask',
  uvicorn: 'uvicorn',
  gunicorn: 'gunicorn',
  celery: 'celery',
  fastapi: 'uvicorn',
  starlette: 'uvicorn',
  typer: null,
  click: null,
};

function frameworkInvocation(framework: string, command: string): string[] {
  const cmdArgs = splitArgs(command);
  if (!framework) {
    throw new Error(
      'Python: framework launch mode selected but no framework picked. ' +
      'Pick a framework in the form, or switch to script / module / custom mode.',
    );
  }
  // Special case: a frameworkCommand starting with `manage.py ` (or any
  // `*.py ` script reference) runs the script directly. This is how
  // Django configs work — `manage.py runserver` auto-loads
  // DJANGO_SETTINGS_MODULE the way `python -m django runserver` does
  // not. Same `script.py args...` shape as launchMode='script', but
  // accessible via the framework dropdown.
  if (cmdArgs.length > 0 && cmdArgs[0].endsWith('.py')) {
    return cmdArgs;
  }
  const target = FRAMEWORK_M_TARGET[framework];
  if (target === null) {
    // typer / click — the user's command IS the invocation.
    return cmdArgs;
  }
  if (target === undefined) {
    // Unknown framework — fall back to passing the framework name as the
    // -m target, matching the pre-existing behavior.
    return ['-m', framework, ...cmdArgs];
  }
  return ['-m', target, ...cmdArgs];
}
