import { RecomputeTimeoutError } from '../src/adapters/spring-boot/recomputeClasspath';

describe('RecomputeTimeoutError', () => {
  test('message contains command, timeout in seconds, and a retry hint', () => {
    const err = new RecomputeTimeoutError('./gradlew', 90_000, '');
    expect(err.message).toContain('./gradlew');
    expect(err.message).toContain('90s');
    // The whole point — the hint must tell the user to retry.
    expect(err.message.toLowerCase()).toContain('again');
  });

  test('partial stderr is appended (truncated to the tail) when non-empty', () => {
    const longStderr = 'early junk\n'.repeat(200) + 'RELEVANT TAIL LINE';
    const err = new RecomputeTimeoutError('./gradlew', 90_000, longStderr);
    expect(err.message).toContain('RELEVANT TAIL LINE');
    expect(err.message.length).toBeLessThan(longStderr.length + 500);
  });

  test('empty stderr does NOT add a "Last output:" section', () => {
    const err = new RecomputeTimeoutError('./gradlew', 90_000, '   \n');
    expect(err.message).not.toContain('Last output');
  });

  test('instanceof check works so callers can special-case it', () => {
    const err = new RecomputeTimeoutError('mvn', 90_000, '');
    expect(err).toBeInstanceOf(RecomputeTimeoutError);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe('RecomputeTimeoutError');
  });
});
