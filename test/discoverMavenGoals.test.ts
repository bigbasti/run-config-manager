import { Uri, __resetFs, __writeFs } from 'vscode';
import { discoverMavenGoals, parseDescribeOutput } from '../src/adapters/maven-goal/discoverMavenGoals';

describe('discoverMavenGoals (integration — falls back to prefixes when mvn unavailable)', () => {
  beforeEach(() => __resetFs());

  test('returns standard lifecycle phases even without a pom.xml', async () => {
    const goals = await discoverMavenGoals({ folder: Uri.file('/empty') });
    const phaseNames = goals.map(g => g.value);
    expect(phaseNames).toContain('clean');
    expect(phaseNames).toContain('install');
    expect(phaseNames).toContain('package');
  });

  test('plugin probe timeout / failure falls back to prefix entries', async () => {
    __writeFs('/proj/pom.xml', `
<project>
  <build>
    <plugins>
      <plugin>
        <groupId>org.liquibase</groupId>
        <artifactId>liquibase-maven-plugin</artifactId>
        <version>4.20.0</version>
      </plugin>
    </plugins>
  </build>
</project>
`);
    // The test invokes 'mvn' which probably isn't on the jest sandbox's
    // PATH, or if it is the probe will hit a real internet repo — we cut
    // both possibilities with a 500ms timeout so the test stays fast and
    // deterministic.
    const goals = await discoverMavenGoals({
      folder: Uri.file('/proj'),
      mavenBinary: 'mvn-not-a-real-binary',
      timeoutMs: 500,
    });
    // Fallback: the plugin is surfaced as a prefix entry.
    expect(goals.some(g => g.value === 'liquibase:')).toBe(true);
  });

  test('deduplicates plugins with different suffixes but same prefix', async () => {
    __writeFs('/proj/pom.xml', `
<project><build><plugins>
  <plugin><artifactId>surefire-plugin</artifactId></plugin>
  <plugin><artifactId>maven-surefire-plugin</artifactId></plugin>
</plugins></build></project>
`);
    const goals = await discoverMavenGoals({
      folder: Uri.file('/proj'),
      mavenBinary: 'mvn-not-a-real-binary',
      timeoutMs: 500,
    });
    // Two pom entries but both fall back to the same prefix → one result.
    const surefire = goals.filter(g => g.value === 'surefire:');
    expect(surefire.length).toBe(1);
  });
});

describe('parseDescribeOutput', () => {
  test('parses a canonical help:describe output', () => {
    const out = `
This plugin has 4 goals:

liquibase:dropAll
  Description: Drop all database objects owned by the user.

liquibase:update
  Description: Applies the DatabaseChangeLogs to the database.
    Useful as part of the build process.

liquibase:status
  Description: Prints which changesets would be executed next.

For more information, run 'mvn help:describe [...] -Ddetail'

[INFO] ------------------------------------------------------------------------
[INFO] BUILD SUCCESS
`;
    const goals = parseDescribeOutput(out);
    expect(goals).toContainEqual({
      value: 'liquibase:dropAll',
      description: 'Drop all database objects owned by the user.',
    });
    expect(goals).toContainEqual({
      value: 'liquibase:update',
      description: 'Applies the DatabaseChangeLogs to the database. Useful as part of the build process.',
    });
    expect(goals).toContainEqual({
      value: 'liquibase:status',
      description: 'Prints which changesets would be executed next.',
    });
  });

  test('ignores INFO / WARNING / ERROR banner lines', () => {
    const out = `
[INFO] ------------------------------------------------------------------------
[INFO] Building Standalone Project 1
[INFO] ------------------------------------------------------------------------
[INFO] --- help:3.5.1:describe (default-cli) @ standalone-pom ---

compiler:compile
  Description: Compiles application sources.

[WARNING] Some deprecation notice
`;
    const goals = parseDescribeOutput(out);
    expect(goals).toContainEqual({
      value: 'compiler:compile',
      description: 'Compiles application sources.',
    });
  });

  test('returns [] for empty / unparseable output', () => {
    expect(parseDescribeOutput('')).toEqual([]);
    expect(parseDescribeOutput('no goals here')).toEqual([]);
  });
});
