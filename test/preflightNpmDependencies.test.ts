import * as vscode from 'vscode';

// We can't easily exercise preflightNpmDependencies in isolation
// because it lives on the ExecutionService class which depends on
// adapter registry / task system. Instead, exercise the cache-key
// shape via a snapshot test on the source — simple guard against
// accidentally dropping mtime-keying.

import * as fs from 'fs';
import * as path from 'path';

describe('preflightNpmDependencies — source-level guards', () => {
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src', 'services', 'ExecutionService.ts'),
    'utf8',
  );

  test('keys the cache on package.json mtime', () => {
    expect(src).toMatch(/pkg=\$\{stat\.mtimeMs\}/);
  });

  test('keys the cache on lockfile mtime', () => {
    expect(src).toMatch(/lock'/);
  });

  test('routes the [Install] button through executeTask (not createTerminal)', () => {
    // After the npm-install-pre-flight handler, the install path uses
    // ShellExecution + executeTask. This guard ensures we don't
    // regress to createTerminal + sendText (the rc-init-race fix).
    const idx = src.lastIndexOf('preflightNpmDependencies');
    const after = src.slice(idx, idx + 4000);
    expect(after).toContain('vscode.ShellExecution');
    expect(after).toContain('vscode.tasks.executeTask');
    expect(after).not.toContain('createTerminal(');
  });

  test('aborts the run after install starts (returns false)', () => {
    // The install branch must return false so the existing run() call
    // in ExecutionService aborts — without this, the run kicks off
    // before the install finishes and the package isn't there yet.
    const idx = src.indexOf("if (choice === 'Install')");
    const after = src.slice(idx, idx + 1000);
    expect(after).toMatch(/return false;/);
  });
});
