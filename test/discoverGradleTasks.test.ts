import { parseGradleTasksOutput } from '../src/adapters/gradle-task/discoverGradleTasks';

describe('parseGradleTasksOutput', () => {
  test('parses a canonical tasks --all output', () => {
    const out = `
> Task :tasks

------------------------------------------------------------
All tasks runnable from project ':api'
------------------------------------------------------------

Build tasks
-----------
assemble - Assembles the outputs of this project.
classes - Assembles main classes.

Liquibase tasks
---------------
dropAll - Drop all database objects owned by the user.
update - Apply all pending changesets to the database.
`;
    const tasks = parseGradleTasksOutput(out);
    expect(tasks).toContainEqual({ group: 'Build tasks', name: 'assemble', description: 'Assembles the outputs of this project.' });
    expect(tasks).toContainEqual({ group: 'Build tasks', name: 'classes', description: 'Assembles main classes.' });
    expect(tasks).toContainEqual({ group: 'Liquibase tasks', name: 'dropAll', description: 'Drop all database objects owned by the user.' });
    expect(tasks).toContainEqual({ group: 'Liquibase tasks', name: 'update', description: 'Apply all pending changesets to the database.' });
  });

  test('tolerates tasks without descriptions', () => {
    const out = `
Verification tasks
------------------
test
check
`;
    const tasks = parseGradleTasksOutput(out);
    expect(tasks).toContainEqual({ group: 'Verification tasks', name: 'test', description: '' });
    expect(tasks).toContainEqual({ group: 'Verification tasks', name: 'check', description: '' });
  });

  test('ignores header bars + blank lines + task runner messages', () => {
    const out = `
> Task :tasks
BUILD SUCCESSFUL in 2s

Build tasks
-----------
assemble - Assembles the outputs.

Rules
-----
Pattern: build<ConfigurationName>
`;
    const tasks = parseGradleTasksOutput(out);
    expect(tasks.map(t => t.name)).toEqual(['assemble']);
  });

  test('returns [] for empty / unparseable output', () => {
    expect(parseGradleTasksOutput('')).toEqual([]);
    expect(parseGradleTasksOutput('nothing relevant here')).toEqual([]);
  });

  test('recognises module-scoped task names like :api:test', () => {
    const out = `
Other tasks
-----------
:api:test - Runs the tests
`;
    const tasks = parseGradleTasksOutput(out);
    expect(tasks).toContainEqual({ group: 'Other tasks', name: ':api:test', description: 'Runs the tests' });
  });
});
