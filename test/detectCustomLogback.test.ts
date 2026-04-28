import { Uri, __resetFs, __writeFs } from 'vscode';
import { hasCustomLogback } from '../src/adapters/spring-boot/detectCustomLogback';

const ROOT = Uri.file('/proj');

beforeEach(() => __resetFs());

describe('hasCustomLogback', () => {
  test('returns false when no logging config exists', async () => {
    expect(await hasCustomLogback(ROOT)).toBe(false);
  });

  test('detects logback-spring.xml with <pattern>', async () => {
    __writeFs('/proj/src/main/resources/logback-spring.xml', `
      <configuration>
        <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
          <encoder>
            <pattern>%d %-5level [%thread] %logger - %msg%n</pattern>
          </encoder>
        </appender>
      </configuration>
    `);
    expect(await hasCustomLogback(ROOT)).toBe(true);
  });

  test('detects logback.xml with <pattern>', async () => {
    __writeFs('/proj/src/main/resources/logback.xml', `
      <configuration>
        <appender name="CONSOLE" class="ch.qos.logback.core.ConsoleAppender">
          <encoder>
            <pattern>%msg%n</pattern>
          </encoder>
        </appender>
      </configuration>
    `);
    expect(await hasCustomLogback(ROOT)).toBe(true);
  });

  test('detects log4j2.xml with PatternLayout pattern attribute', async () => {
    __writeFs('/proj/src/main/resources/log4j2.xml', `
      <Configuration>
        <Appenders>
          <Console name="CONSOLE">
            <PatternLayout pattern="%d %-5p %c{1} - %m%n"/>
          </Console>
        </Appenders>
      </Configuration>
    `);
    expect(await hasCustomLogback(ROOT)).toBe(true);
  });

  test('returns false for a logback file with no <pattern>', async () => {
    // A file that imports Spring's defaults via <include resource="..."/>
    // and doesn't declare its own <pattern> won't override us.
    __writeFs('/proj/src/main/resources/logback-spring.xml', `
      <configuration>
        <include resource="org/springframework/boot/logging/logback/base.xml"/>
      </configuration>
    `);
    expect(await hasCustomLogback(ROOT)).toBe(false);
  });

  test('logback-spring.xml takes precedence over logback.xml', async () => {
    // Both files exist — logback-spring.xml is checked first and has a
    // pattern, so the probe returns true. We don't need to check
    // logback.xml as well (early-exit).
    __writeFs('/proj/src/main/resources/logback-spring.xml', '<configuration><pattern>foo</pattern></configuration>');
    __writeFs('/proj/src/main/resources/logback.xml', '<configuration/>');
    expect(await hasCustomLogback(ROOT)).toBe(true);
  });

  test('case-insensitive pattern match', async () => {
    __writeFs('/proj/src/main/resources/log4j2.xml', '<PATTERNLAYOUT pattern="x"/>');
    expect(await hasCustomLogback(ROOT)).toBe(true);
  });
});
