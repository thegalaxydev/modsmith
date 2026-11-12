import { describe, expect, it } from 'vitest';
import { shortDetail } from '../src/renderer/javaCompletion';

describe('Java completion details', () => {
  it('shows the declaring type when the detail repeats the label', () => {
    expect(shortDetail('atDebug() : LoggingEventBuilder', 'Logger.atDebug() : LoggingEventBuilder')).toBe('Logger');
    expect(shortDetail('info(String msg) : void', 'org.slf4j.Logger.info(String msg) : void')).toBe('org.slf4j.Logger');
  });

  it('keeps details that add something', () => {
    expect(shortDetail('Level - java.lang.System.Logger', 'java.lang.System.Logger.Level')).toBe('java.lang.System.Logger.Level');
    expect(shortDetail('MOD_ID', 'String')).toBe('String');
    expect(shortDetail('x', 'x')).toBe('x');
  });
});
