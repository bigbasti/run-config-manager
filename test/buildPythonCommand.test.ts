import { buildPythonCommand } from '../src/adapters/python/buildPythonCommand';
import type { RunConfig } from '../src/shared/types';

const base: any = {
  id: 'i', name: 'x', projectPath: '', workspaceFolder: '',
  env: {}, programArgs: '', vmArgs: '',
};

function cfg(overrides: any): RunConfig {
  return {
    ...base,
    type: 'python',
    typeOptions: {
      launchMode: 'script',
      pythonPath: '/opt/py-3.12',
      scriptPath: 'main.py',
      moduleName: '',
      framework: '',
      frameworkCommand: '',
      pytestArgs: '',
      customArgs: '',
      buildRoot: '',
      ...overrides,
    },
  } as RunConfig;
}

describe('buildPythonCommand', () => {
  test('script mode', () => {
    const out = buildPythonCommand(cfg({ launchMode: 'script', scriptPath: 'app.py' }));
    expect(out.command.endsWith('python3') || out.command.endsWith('python.exe')).toBe(true);
    expect(out.args).toEqual(['app.py']);
  });
  test('script mode with programArgs', () => {
    const c = cfg({ launchMode: 'script', scriptPath: 'app.py' });
    (c as any).programArgs = '--port 9000 --debug';
    const out = buildPythonCommand(c);
    expect(out.args).toEqual(['app.py', '--port', '9000', '--debug']);
  });
  test('module mode', () => {
    const out = buildPythonCommand(cfg({ launchMode: 'module', moduleName: 'mypkg.cli' }));
    expect(out.args).toEqual(['-m', 'mypkg.cli']);
  });
  test('framework: django', () => {
    const out = buildPythonCommand(cfg({
      launchMode: 'framework', framework: 'django', frameworkCommand: 'runserver',
    }));
    expect(out.args).toEqual(['-m', 'django', 'runserver']);
  });
  test('framework: uvicorn', () => {
    const out = buildPythonCommand(cfg({
      launchMode: 'framework', framework: 'uvicorn', frameworkCommand: 'app:main --reload',
    }));
    expect(out.args).toEqual(['-m', 'uvicorn', 'app:main', '--reload']);
  });
  test('framework: gunicorn', () => {
    const out = buildPythonCommand(cfg({
      launchMode: 'framework', framework: 'gunicorn', frameworkCommand: 'app:app -b 0.0.0.0:8000',
    }));
    expect(out.args).toEqual(['-m', 'gunicorn', 'app:app', '-b', '0.0.0.0:8000']);
  });
  test('pytest mode', () => {
    const out = buildPythonCommand(cfg({ launchMode: 'pytest', pytestArgs: 'tests/foo.py -k smoke' }));
    expect(out.args).toEqual(['-m', 'pytest', 'tests/foo.py', '-k', 'smoke']);
  });
  test('custom mode', () => {
    const out = buildPythonCommand(cfg({ launchMode: 'custom', customArgs: '-c "print(1)"' }));
    expect(out.args).toEqual(['-c', 'print(1)']);
  });
  test('falls back to python3 on PATH when pythonPath is empty', () => {
    const out = buildPythonCommand(cfg({ pythonPath: '', scriptPath: 'app.py' }));
    expect(out.command).toBe('python3');
  });
  test('vmArgs (interpreter args) come BEFORE script', () => {
    const c = cfg({ launchMode: 'script', scriptPath: 'app.py' });
    (c as any).vmArgs = '-O -W default';
    const out = buildPythonCommand(c);
    expect(out.args).toEqual(['-O', '-W', 'default', 'app.py']);
  });
});
