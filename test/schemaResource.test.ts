import { runConfigJsonSchema } from '../src/mcp/schemaResource';

describe('runConfigJsonSchema', () => {
  it('produces an object schema string mentioning every config type', () => {
    const schema = runConfigJsonSchema();
    const json = JSON.stringify(schema);
    for (const t of [
      'npm', 'spring-boot', 'tomcat', 'quarkus', 'java', 'python',
      'maven-goal', 'gradle-task', 'custom-command', 'docker',
      'http-request', 'go',
    ]) {
      expect(json).toContain(`"${t}"`);
    }
  });

  it('includes common base field names', () => {
    const json = JSON.stringify(runConfigJsonSchema());
    expect(json).toContain('projectPath');
    expect(json).toContain('typeOptions');
  });
});
