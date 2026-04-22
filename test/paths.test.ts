import { Uri } from 'vscode';
import { resolveProjectUri, relativeFromWorkspace } from '../src/utils/paths';

describe('paths', () => {
  const folder = { uri: Uri.file('/ws/app'), name: 'app', index: 0 };

  test('resolveProjectUri joins workspace folder and projectPath', () => {
    const r = resolveProjectUri(folder, 'frontend');
    expect(r.fsPath).toBe('/ws/app/frontend');
  });

  test('resolveProjectUri with empty projectPath returns the folder itself', () => {
    const r = resolveProjectUri(folder, '');
    expect(r.fsPath).toBe('/ws/app');
  });

  test('relativeFromWorkspace returns posix-normalized relative path', () => {
    expect(relativeFromWorkspace(folder, Uri.file('/ws/app/frontend'))).toBe('frontend');
    expect(relativeFromWorkspace(folder, Uri.file('/ws/app/a/b/c'))).toBe('a/b/c');
  });

  test('relativeFromWorkspace returns empty string when target equals folder', () => {
    expect(relativeFromWorkspace(folder, Uri.file('/ws/app'))).toBe('');
  });
});
