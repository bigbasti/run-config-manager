import { Uri } from 'vscode';
import { deriveDefaultName } from '../src/extension';

const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 } as any;

describe('deriveDefaultName', () => {
  test('uses the project folder basename, capitalised', () => {
    const name = deriveDefaultName(Uri.file('/ws/api'), folder, 'Spring Boot');
    expect(name).toBe('Api Spring Boot');
  });

  test('falls back to workspace folder name when project is the workspace root', () => {
    // filter(Boolean).pop() on "/ws" yields "ws" — close enough; the spec
    // said "workspace folder name" but the fsPath basename is identical here.
    const name = deriveDefaultName(Uri.file('/ws'), folder, 'Gradle Task');
    expect(name).toBe('Ws Gradle Task');
  });

  test('works for systest subdirs', () => {
    expect(deriveDefaultName(Uri.file('/ws/systemtest'), folder, 'Maven Goal'))
      .toBe('Systemtest Maven Goal');
  });

  test('uses the full type label verbatim', () => {
    expect(deriveDefaultName(Uri.file('/ws/web'), folder, 'npm / Node.js'))
      .toBe('Web npm / Node.js');
  });
});
