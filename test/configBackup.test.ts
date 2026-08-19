import * as vscode from 'vscode';
import { __resetFs, __readFs } from 'vscode';
import { archiveRunJson, backupFileName, BACKUP_DIR_NAME } from '../src/services/configBackup';

describe('backupFileName', () => {
  test('formats as <folder>_run.json_<date>_<time>', () => {
    const when = new Date(2026, 7, 19, 9, 13, 33);
    expect(backupFileName('dds2', when)).toBe('dds2_run.json_2026-08-19_09-13-33');
  });

  test('zero-pads every component', () => {
    const when = new Date(2026, 0, 2, 3, 4, 5);
    expect(backupFileName('a', when)).toBe('a_run.json_2026-01-02_03-04-05');
  });

  test('sanitises characters that are illegal in a filename', () => {
    const when = new Date(2026, 7, 19, 9, 13, 33);
    expect(backupFileName('my project/sub', when))
      .toBe('my_project_sub_run.json_2026-08-19_09-13-33');
    expect(backupFileName('a:b*c?', when))
      .toBe('a_b_c__run.json_2026-08-19_09-13-33');
  });

  test('keeps dots, dashes and underscores', () => {
    const when = new Date(2026, 7, 19, 9, 13, 33);
    expect(backupFileName('my-app_v1.2', when))
      .toBe('my-app_v1.2_run.json_2026-08-19_09-13-33');
  });

  test('falls back to a placeholder for an empty folder name', () => {
    const when = new Date(2026, 7, 19, 9, 13, 33);
    expect(backupFileName('', when)).toBe('workspace_run.json_2026-08-19_09-13-33');
  });
});

describe('archiveRunJson', () => {
  beforeEach(() => { __resetFs(); jest.restoreAllMocks(); });

  test('writes the contents under <home>/.run-configs and returns the path', async () => {
    const path = await archiveRunJson({
      homeDir: '/home/tester',
      folderName: 'dds2',
      contents: '{"version":1}',
      now: new Date(2026, 7, 19, 9, 13, 33),
    });
    const expected = `/home/tester/${BACKUP_DIR_NAME}/dds2_run.json_2026-08-19_09-13-33`;
    expect(path).toBe(expected);
    expect(__readFs(expected)).toBe('{"version":1}');
  });

  test('creates the backup directory before writing', async () => {
    const spy = jest.spyOn(vscode.workspace.fs, 'createDirectory');
    await archiveRunJson({
      homeDir: '/home/tester',
      folderName: 'dds2',
      contents: '{}',
      now: new Date(2026, 7, 19, 9, 13, 33),
    });
    expect(spy).toHaveBeenCalled();
    expect((spy.mock.calls[0][0] as any).fsPath).toBe(`/home/tester/${BACKUP_DIR_NAME}`);
  });

  test('returns undefined and does not throw when the write fails', async () => {
    jest.spyOn(vscode.workspace.fs, 'writeFile')
      .mockRejectedValue(new Error('EROFS: read-only file system'));
    await expect(archiveRunJson({
      homeDir: '/home/tester',
      folderName: 'dds2',
      contents: '{}',
      now: new Date(2026, 7, 19, 9, 13, 33),
    })).resolves.toBeUndefined();
  });

  test('returns undefined when there is no home directory', async () => {
    await expect(archiveRunJson({
      homeDir: '',
      folderName: 'dds2',
      contents: '{}',
      now: new Date(2026, 7, 19, 9, 13, 33),
    })).resolves.toBeUndefined();
  });
});
