import { describe, expect, it } from 'vitest';
import { absoluteInWorkspace, relativeToWorkspace, toggleLine } from '../src/renderer/debugger';

describe('debugger paths and breakpoints', () => {
  it('maps adapter paths to workspace files and back', () => {
    expect(relativeToWorkspace(String.raw`C:\Mods\demo`, String.raw`c:\mods\demo\src\main\java\A.java`)).toBe('src/main/java/A.java');
    expect(relativeToWorkspace('/home/me/demo', '/home/me/demo/src/A.java')).toBe('src/A.java');
    expect(relativeToWorkspace('/home/me/demo', '/home/me/demo2/src/A.java')).toBeNull();
    expect(absoluteInWorkspace(String.raw`C:\Mods\demo`, 'src/main/java/A.java')).toBe(String.raw`C:\Mods\demo\src\main\java\A.java`);
    expect(absoluteInWorkspace('/home/me/demo/', 'src/A.java')).toBe('/home/me/demo/src/A.java');
  });

  it('toggles breakpoint lines in order', () => {
    expect(toggleLine([5, 20], 12)).toEqual([5, 12, 20]);
    expect(toggleLine([5, 12, 20], 12)).toEqual([5, 20]);
  });
});
