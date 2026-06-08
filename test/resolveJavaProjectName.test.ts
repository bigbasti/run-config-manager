import { Uri, __writeFs } from 'vscode';
import { resolveJavaProjectName } from '../src/utils/javaProjectName';

const folder = { uri: Uri.file('/ws'), name: 'ws', index: 0 };

describe('resolveJavaProjectName', () => {
  test('returns the module artifactId from pom.xml (ignoring the parent block)', async () => {
    __writeFs(
      '/ws/api/pom.xml',
      `<project>
         <parent>
           <groupId>com.acme</groupId>
           <artifactId>acme-parent</artifactId>
           <version>1.0.0</version>
         </parent>
         <artifactId>acme-api</artifactId>
       </project>`,
    );
    const name = await resolveJavaProjectName(folder as any, 'api');
    expect(name).toBe('acme-api');
  });

  test('returns rootProject.name from settings.gradle when no pom present', async () => {
    __writeFs('/ws/svc/settings.gradle', `rootProject.name = 'my-service'`);
    const name = await resolveJavaProjectName(folder as any, 'svc');
    expect(name).toBe('my-service');
  });

  test('falls back to the project directory name when nothing is detectable', async () => {
    const name = await resolveJavaProjectName(folder as any, 'unmanaged-module');
    expect(name).toBe('unmanaged-module');
  });

  test('falls back to the workspace folder name when projectPath is empty', async () => {
    const name = await resolveJavaProjectName(folder as any, '');
    expect(name).toBe('ws');
  });
});
