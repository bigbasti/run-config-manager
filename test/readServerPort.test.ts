import { Uri, __resetFs, __writeFs } from 'vscode';
import { readServerPort } from '../src/adapters/spring-boot/readServerPort';

describe('readServerPort', () => {
  beforeEach(() => __resetFs());

  test('returns null when no properties file exists', async () => {
    const port = await readServerPort(Uri.file('/proj'), '');
    expect(port).toBeNull();
  });

  test('reads server.port from application.properties', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'server.port=8888\n');
    const port = await readServerPort(Uri.file('/proj'), '');
    expect(port).toBe(8888);
  });

  test('prefers profile-specific file when profile is active', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'server.port=8080\n');
    __writeFs('/proj/src/main/resources/application-dev.properties', 'server.port=8181\n');
    const port = await readServerPort(Uri.file('/proj'), 'dev');
    expect(port).toBe(8181);
  });

  test('last profile wins when multiple active', async () => {
    __writeFs('/proj/src/main/resources/application-dev.properties', 'server.port=8181\n');
    __writeFs('/proj/src/main/resources/application-local.properties', 'server.port=8282\n');
    const port = await readServerPort(Uri.file('/proj'), 'dev,local');
    expect(port).toBe(8282);
  });

  test('falls back to base file when profile file has no port', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'server.port=9090\n');
    __writeFs('/proj/src/main/resources/application-dev.properties', 'logging.level.root=DEBUG\n');
    const port = await readServerPort(Uri.file('/proj'), 'dev');
    expect(port).toBe(9090);
  });

  test('reads from nested module src/main/resources', async () => {
    __writeFs('/proj/api/src/main/resources/application-dev.properties', 'server.port=7777\n');
    const port = await readServerPort(Uri.file('/proj'), 'dev');
    expect(port).toBe(7777);
  });

  test('YAML indented form', async () => {
    __writeFs('/proj/src/main/resources/application.yml', 'server:\n  port: 5555\n');
    const port = await readServerPort(Uri.file('/proj'), '');
    expect(port).toBe(5555);
  });

  test('YAML flat form', async () => {
    __writeFs('/proj/src/main/resources/application.yml', 'server.port: 6666\n');
    const port = await readServerPort(Uri.file('/proj'), '');
    expect(port).toBe(6666);
  });

  test('ignores placeholder values like ${PORT}', async () => {
    __writeFs('/proj/src/main/resources/application.properties', 'server.port=${PORT}\n');
    const port = await readServerPort(Uri.file('/proj'), '');
    expect(port).toBeNull();
  });
});
