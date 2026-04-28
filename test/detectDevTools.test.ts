import { Uri, __resetFs, __writeFs } from 'vscode';
import { hasSpringBootDevTools } from '../src/adapters/spring-boot/detectDevTools';

const ROOT = Uri.file('/proj');

beforeEach(() => __resetFs());

describe('hasSpringBootDevTools', () => {
  test('returns false when no build file exists', async () => {
    expect(await hasSpringBootDevTools(ROOT)).toBe(false);
  });

  test('detects devtools in build.gradle (developmentOnly)', async () => {
    __writeFs('/proj/build.gradle', `
      dependencies {
        implementation 'org.springframework.boot:spring-boot-starter-web'
        developmentOnly 'org.springframework.boot:spring-boot-devtools'
      }
    `);
    expect(await hasSpringBootDevTools(ROOT)).toBe(true);
  });

  test('detects devtools in build.gradle.kts with parentheses', async () => {
    __writeFs('/proj/build.gradle.kts', `
      dependencies {
        developmentOnly("org.springframework.boot:spring-boot-devtools")
      }
    `);
    expect(await hasSpringBootDevTools(ROOT)).toBe(true);
  });

  test('detects devtools in pom.xml', async () => {
    __writeFs('/proj/pom.xml', `
      <dependencies>
        <dependency>
          <groupId>org.springframework.boot</groupId>
          <artifactId>spring-boot-devtools</artifactId>
          <optional>true</optional>
        </dependency>
      </dependencies>
    `);
    expect(await hasSpringBootDevTools(ROOT)).toBe(true);
  });

  test('detects devtools with whitespace-padded artifactId', async () => {
    __writeFs('/proj/pom.xml', `
      <dependency>
        <artifactId>  spring-boot-devtools  </artifactId>
      </dependency>
    `);
    expect(await hasSpringBootDevTools(ROOT)).toBe(true);
  });

  test('returns false for a build file that has spring-boot-starter-web but not devtools', async () => {
    __writeFs('/proj/build.gradle', `
      dependencies {
        implementation 'org.springframework.boot:spring-boot-starter-web'
        implementation 'org.springframework.boot:spring-boot-starter-data-jpa'
      }
    `);
    expect(await hasSpringBootDevTools(ROOT)).toBe(false);
  });

  test('prefers build.gradle but falls back to build.gradle.kts', async () => {
    // No plain build.gradle; kts variant exists.
    __writeFs('/proj/build.gradle.kts', `
      dependencies {
        developmentOnly("org.springframework.boot:spring-boot-devtools")
      }
    `);
    expect(await hasSpringBootDevTools(ROOT)).toBe(true);
  });
});
