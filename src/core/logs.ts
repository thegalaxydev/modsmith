import type { LogLine } from '../shared/types';

const PATTERNS: RegExp[] = [
  /^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\] \[([^\]]+?)\/([A-Z]+)\] \(([^)]*)\) (.*)$/,
  /^\[(\d{2}:\d{2}:\d{2}(?:\.\d+)?)\] \[([^\]]+?)\/([A-Z]+)\]: (?:\[([^\]]*)\] )?(.*)$/,
  /^\[(\d{2}[A-Za-z]{3}\d{4} \d{2}:\d{2}:\d{2}\.\d+)\] \[([^\]]+?)\/([A-Z]+)\] \[([^\]]*)\]: (.*)$/
];

export function parseLogLine(text: string): Pick<LogLine, 'time' | 'thread' | 'level' | 'logger' | 'message'> {
  for (const re of PATTERNS) {
    const m = text.match(re);
    if (m) return { time: m[1], thread: m[2], level: m[3], logger: m[4] || undefined, message: m[5] };
  }
  if (/^\s+at [\w$.]+\(.*\)$/.test(text) || /^Caused by: /.test(text) || /^\s*\.\.\. \d+ more$/.test(text)) return { level: 'TRACE', message: text };
  return { message: text };
}

export class LogBuffer {
  private lines: LogLine[] = [];
  private seq = 0;
  private lastLevel: string | undefined;

  constructor(private capacity = 50000) {}

  push(stream: LogLine['stream'], text: string): LogLine {
    const parsed = parseLogLine(text);
    if (parsed.level === 'TRACE') parsed.level = this.lastLevel ?? 'ERROR';
    else if (parsed.level) this.lastLevel = parsed.level;
    const line: LogLine = { seq: ++this.seq, ts: Date.now(), stream, text, ...parsed };
    if (!line.level && stream === 'stderr') line.level = 'STDERR';
    this.lines.push(line);
    if (this.lines.length > this.capacity) this.lines.splice(0, this.lines.length - this.capacity);
    return line;
  }

  query(opts: { since?: number; limit?: number; levels?: string[]; search?: string; logger?: string; thread?: string } = {}): LogLine[] {
    let out = this.lines;
    if (opts.since) out = out.filter((l) => l.seq > opts.since!);
    if (opts.levels?.length) out = out.filter((l) => l.level && opts.levels!.includes(l.level));
    if (opts.logger) out = out.filter((l) => l.logger === opts.logger);
    if (opts.thread) out = out.filter((l) => l.thread === opts.thread);
    if (opts.search) {
      const s = opts.search.toLowerCase();
      out = out.filter((l) => l.text.toLowerCase().includes(s));
    }
    const limit = opts.limit ?? 1000;
    return out.slice(-limit);
  }

  get lastSeq(): number {
    return this.seq;
  }
}
