import { Uri, __resetFs, __writeFs } from 'vscode';
import { discoverMavenGoals } from '../src/adapters/maven-goal/discoverMavenGoals';

describe('discoverMavenGoals', () => {
  beforeEach(() => __resetFs());

  test('returns standard lifecycle phases even without a pom.xml', async () => {
    const goals = await discoverMavenGoals(Uri.file('/empty'));
    const phaseNames = goals.map(g => g.value);
    expect(phaseNames).toContain('clean');
    expect(phaseNames).toContain('install');
    expect(phaseNames).toContain('package');
  });

  test('adds plugin prefixes from <plugin> entries in pom.xml', async () => {
    __writeFs('/proj/pom.xml', `
<project>
  <build>
    <plugins>
      <plugin>
        <groupId>org.liquibase</groupId>
        <artifactId>liquibase-maven-plugin</artifactId>
        <version>4.20.0</version>
      </plugin>
      <plugin>
        <groupId>org.springframework.boot</groupId>
        <artifactId>spring-boot-maven-plugin</artifactId>
      </plugin>
    </plugins>
  </build>
</project>
`);
    const goals = await discoverMavenGoals(Uri.file('/proj'));
    const prefixes = goals.map(g => g.value);
    expect(prefixes).toContain('liquibase:');
    expect(prefixes).toContain('spring-boot:');
  });

  test('skips duplicate plugin suffixes', async () => {
    __writeFs('/proj/pom.xml', `
<project><build><plugins>
  <plugin><artifactId>surefire-plugin</artifactId></plugin>
  <plugin><artifactId>maven-surefire-plugin</artifactId></plugin>
</plugins></build></project>
`);
    const goals = await discoverMavenGoals(Uri.file('/proj'));
    const surefire = goals.filter(g => g.value === 'surefire:');
    expect(surefire.length).toBe(1);
  });
});
