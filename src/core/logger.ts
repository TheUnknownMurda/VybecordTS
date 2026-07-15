import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const LEVEL_COLORS: Record<LogLevel, string> = {
  debug: '\x1b[38;2;128;128;128m', // gray
  info:  '\x1b[38;2;200;200;200m', // light gray
  warn:  '\x1b[38;2;255;200;100m', // orange
  error: '\x1b[38;2;255;100;100m', // red
};

const RESET = '\x1b[0m';

// ── Rainbow gradient (vibrant pink → orange → yellow → green → cyan → blue) ──
// Same left-to-right per-character gradient used by "PC Gaming Redists" style
// installer banners. Reserved for decorative/banner output, not per-line logs.
const RAINBOW: readonly string[] = [
  '\x1b[38;2;255;0;128m',   '\x1b[38;2;255;50;128m',  '\x1b[38;2;255;100;128m',
  '\x1b[38;2;255;150;128m', '\x1b[38;2;255;200;128m', '\x1b[38;2;255;255;128m',
  '\x1b[38;2;255;255;100m', '\x1b[38;2;255;255;50m',  '\x1b[38;2;255;255;0m',
  '\x1b[38;2;200;255;0m',
  '\x1b[38;2;150;255;0m',   '\x1b[38;2;100;255;0m',  '\x1b[38;2;50;255;0m',
  '\x1b[38;2;0;255;0m',     '\x1b[38;2;0;255;50m',   '\x1b[38;2;0;255;100m',
  '\x1b[38;2;0;255;150m',   '\x1b[38;2;0;255;200m',  '\x1b[38;2;0;255;255m',
  '\x1b[38;2;0;200;255m',
  '\x1b[38;2;0;150;255m',   '\x1b[38;2;0;100;255m',  '\x1b[38;2;0;50;255m',
  '\x1b[38;2;0;0;255m',     '\x1b[38;2;50;0;255m',   '\x1b[38;2;100;0;255m',
  '\x1b[38;2;150;0;255m',   '\x1b[38;2;200;0;255m',  '\x1b[38;2;255;0;255m',
  '\x1b[38;2;255;0;200m',
  '\x1b[38;2;255;0;150m',   '\x1b[38;2;255;0;100m',  '\x1b[38;2;255;0;50m',
  '\x1b[38;2;255;0;0m',     '\x1b[38;2;255;50;0m',   '\x1b[38;2;255;100;0m',
  '\x1b[38;2;255;150;0m',   '\x1b[38;2;255;200;0m',  '\x1b[38;2;255;255;0m',
  '\x1b[38;2;200;255;0m',
  '\x1b[38;2;150;255;0m',   '\x1b[38;2;100;255;0m',  '\x1b[38;2;50;255;0m',
  '\x1b[38;2;0;255;0m',     '\x1b[38;2;0;255;50m',   '\x1b[38;2;0;255;100m',
  '\x1b[38;2;0;255;150m',   '\x1b[38;2;0;255;200m',  '\x1b[38;2;0;255;255m',
  '\x1b[38;2;0;200;255m',
];

/** Apply the pastel rainbow gradient across a line of text, left to right. */
export function rainbowText(text: string): string {
  const len = text.length;
  if (len === 0) return text;
  let out = '';
  for (let i = 0; i < len; i++) {
    let idx = Math.floor((i / len) * RAINBOW.length);
    if (idx >= RAINBOW.length) idx = RAINBOW.length - 1;
    out += RAINBOW[idx] + text[i];
  }
  return out + RESET;
}

/** Write a rainbow-gradient line to stdout. Log file gets the plain (uncolored) text. */
export function writeRainbow(text: string): void {
  process.stdout.write(rainbowText(text) + '\n');
  if (logFileStream) {
    logBuffer += text + '\n';
    if (logBuffer.length >= LOG_FLUSH_THRESHOLD) flushLogBuffer();
  }
}

/** Write a plain white/light-gray line to stdout (for subtitle text under banner). */
export function writePlain(text: string): void {
  const WHITE = '\x1b[38;2;220;220;220m';
  process.stdout.write(WHITE + text + RESET + '\n');
  if (logFileStream) {
    logBuffer += text + '\n';
    if (logBuffer.length >= LOG_FLUSH_THRESHOLD) flushLogBuffer();
  }
}

// ── Big block-letter font (5x7 dot matrix, uppercase A-Z subset) ──
// Used for the startup logo, in the same spirit as "PC Gaming Redists"'s
// big ASCII-art title. Add more letters here if the logo text changes.
const BLOCK_FONT: Record<string, string[]> = {
  V: ['10001', '10001', '10001', '10001', '10001', '01010', '00100'],
  Y: ['10001', '10001', '01010', '00100', '00100', '00100', '00100'],
  B: ['11110', '10001', '10001', '11110', '10001', '10001', '11110'],
  E: ['11111', '10000', '10000', '11110', '10000', '10000', '11111'],
  C: ['01111', '10000', '10000', '10000', '10000', '10000', '01111'],
  O: ['01110', '10001', '10001', '10001', '10001', '10001', '01110'],
  R: ['11110', '10001', '10001', '11110', '10100', '10010', '10001'],
  D: ['11110', '10001', '10001', '10001', '10001', '10001', '11110'],
  ' ': ['00000', '00000', '00000', '00000', '00000', '00000', '00000'],
};

/** Render text as big 5x7 block-letter ASCII art. Returns one string per row (7 rows). */
export function renderBigText(text: string, scaleX = 2): string[] {
  const rows = 7;
  const lines = new Array(rows).fill('');
  for (const ch of text.toUpperCase()) {
    const glyph = BLOCK_FONT[ch];
    if (!glyph) continue; // skip characters we don't have a glyph for
    for (let r = 0; r < rows; r++) {
      let seg = '';
      for (const bit of glyph[r]) seg += (bit === '1' ? '█' : ' ').repeat(scaleX);
      lines[r] += seg + ' '; // 1-column gap between letters
    }
  }
  return lines.map(l => l.trimEnd());
}

/** Write big block-letter text to stdout, rainbow-gradient applied per row. */
export function writeBigRainbow(text: string, scaleX = 2): void {
  for (const line of renderBigText(text, scaleX)) {
    writeRainbow(line);
  }
}

let globalLevel: LogLevel = 'info';
let logFileStream: fs.WriteStream | null = null;

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB — rotate when exceeded

export function initLogFile(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'vybecord.log');

  // Rotate if existing log exceeds max size
  try {
    if (fs.existsSync(logPath)) {
      const stats = fs.statSync(logPath);
      if (stats.size > MAX_LOG_SIZE) {
        const oldPath = path.join(dir, 'vybecord.old.log');
        if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
        fs.renameSync(logPath, oldPath);
      }
    }
  } catch { /* ignore rotation errors */ }

  logFileStream = fs.createWriteStream(logPath, { flags: 'a' });
  logFileStream.on('error', (err) => {
    // Disable file logging on write error (disk full, permission, etc.)
    process.stderr.write(`[Logger] File write error: ${err.message}\n`);
    logFileStream = null;
  });

  // Start buffered flush timer
  logFlushTimer = setInterval(flushLogBuffer, 200);
  logFlushTimer.unref(); // Don't keep process alive just for logging
}

// ── Buffered file writes (reduce syscalls from per-line to ~5/sec) ──
let logBuffer = '';
let logFlushTimer: ReturnType<typeof setInterval> | null = null;
const LOG_FLUSH_THRESHOLD = 4096; // Flush immediately if buffer exceeds 4KB

function flushLogBuffer(): void {
  if (!logBuffer || !logFileStream) return;
  logFileStream.write(logBuffer);
  logBuffer = '';
}

/** Flush remaining buffer and close the log file. Call before process.exit(). */
export function flushAndClose(): void {
  if (logFlushTimer) { clearInterval(logFlushTimer); logFlushTimer = null; }
  flushLogBuffer();
  if (logFileStream) { logFileStream.end(); logFileStream = null; }
}

// Safety net: flush on process exit (covers unexpected exits)
process.on('beforeExit', flushLogBuffer);

// Pre-padded level tags (avoid toUpperCase + padEnd on every log call)
const LEVEL_TAGS: Record<LogLevel, string> = {
  debug: 'DEBUG',
  info:  'INFO ',
  warn:  'WARN ',
  error: 'ERROR',
};

// Reuse a single Date object to reduce GC pressure on frequent log calls
const _logDate = new Date();

function formatTime(): string {
  _logDate.setTime(Date.now());
  const h = _logDate.getHours();
  const m = _logDate.getMinutes();
  const s = _logDate.getSeconds();
  const ms = _logDate.getMilliseconds();
  return `${h < 10 ? '0' : ''}${h}:${m < 10 ? '0' : ''}${m}:${s < 10 ? '0' : ''}${s}.${ms < 10 ? '00' : ms < 100 ? '0' : ''}${ms}`;
}

export function createLogger(name: string) {
  // Pre-build per-level prefix strings (constant after construction — avoid per-log alloc)
  const consolePrefix: Record<LogLevel, string> = {
    debug: `${LEVEL_COLORS.debug}[${name}]${RESET} `,
    info:  `${LEVEL_COLORS.info}[${name}]${RESET} `,
    warn:  `${LEVEL_COLORS.warn}[${name}]${RESET} `,
    error: `${LEVEL_COLORS.error}[${name}]${RESET} `,
  };
  const fileTag: Record<LogLevel, string> = {
    debug: `[${name}] `,
    info:  `[${name}] `,
    warn:  `[${name}] `,
    error: `[${name}] `,
  };

  const emit = (level: LogLevel, msg: string) => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[globalLevel]) return;

    const ts = formatTime();

    // Console (colored, minimal format)
    process.stdout.write(consolePrefix[level] + msg + '\n');

    // File (buffered, with timestamp)
    if (logFileStream) {
      logBuffer += '[' + ts + fileTag[level] + msg + '\n';
      if (logBuffer.length >= LOG_FLUSH_THRESHOLD) flushLogBuffer();
    }
  };

  return {
    debug: (msg: string) => emit('debug', msg),
    info: (msg: string) => emit('info', msg),
    warn: (msg: string) => emit('warn', msg),
    error: (msg: string) => emit('error', msg),
    raw: (msg: string) => {
      process.stdout.write(msg + '\n');
      if (logFileStream) {
        logBuffer += msg + '\n';
        if (logBuffer.length >= LOG_FLUSH_THRESHOLD) flushLogBuffer();
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;
