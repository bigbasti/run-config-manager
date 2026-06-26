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

  test('resolveProjectUri uses an absolute projectPath as-is (not joined onto the workspace)', () => {
    // A user may type an absolute path for a project that lives outside the
    // open workspace folder. Joining it onto the folder would produce a bogus
    // concatenated path like /ws/app/abs/project/here.
    const r = resolveProjectUri(folder, '/abs/project/here');
    expect(r.fsPath).toBe('/abs/project/here');
  });

  test('resolveProjectUri expands a leading ~ to the home directory', () => {
    const home = require('os').homedir();
    const r = resolveProjectUri(folder, '~/git/other-project');
    expect(r.fsPath).toBe(`${home}/git/other-project`);
  });

  test('relativeFromWorkspace returns posix-normalized relative path', () => {
    expect(relativeFromWorkspace(folder, Uri.file('/ws/app/frontend'))).toBe('frontend');
    expect(relativeFromWorkspace(folder, Uri.file('/ws/app/a/b/c'))).toBe('a/b/c');
  });

  test('relativeFromWorkspace returns empty string when target equals folder', () => {
    expect(relativeFromWorkspace(folder, Uri.file('/ws/app'))).toBe('');
  });
});
