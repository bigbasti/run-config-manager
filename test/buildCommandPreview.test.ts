import { buildCommandPreview } from '../src/shared/buildCommandPreview';
import type { RunConfig } from '../src/shared/types';

const base: RunConfig = {
  id: 'a'.repeat(8) + '-1111-2222-3333-444444444444',
  name: 'x',
  type: 'npm',
  projectPath: 'frontend',
  workspaceFolder: '',
  env: {},
  programArgs: '',
  vmArgs: '',
  typeOptions: { scriptName: 'start', packageManager: 'npm' },
};

describe('buildCommandPreview', () => {
  test('formats npm run start with cwd hint', () => {
    expect(buildCommandPreview(base)).toBe('cd frontend && npm run start');
  });

  test('omits cd when projectPath is empty', () => {
    expect(buildCommandPreview({ ...base, projectPath: '' })).toBe('npm run start');
  });

  test('appends program args after --', () => {
    expect(buildCommandPreview({ ...base, programArgs: '--port 4000' }))
      .toBe('cd frontend && npm run start -- --port 4000');
  });

  test('returns invalid type message for unknown types', () => {
    expect(buildCommandPreview({ ...base, type: 'unknown' as any }))
      .toMatch(/unsupported/i);
  });
});
