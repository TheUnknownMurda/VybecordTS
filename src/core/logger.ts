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
  debug: '\x1b[38;2;190;188;255m', // pastel lavender
  info:  '\x1b[38;2;172;244;255m', // pastel cyan
  warn:  '\x1b[38;2;255;246;170m', // pastel gold
  error: '\x1b[38;2;255;140;140m', // pastel coral-red
};

const RESET = '\x1b[0m';

// ── Rainbow gradient (pastel pink → yellow → green → cyan → blue) ──
// Same left-to-right per-character gradient used by "PC Gaming Redists" style
// installer banners. Reserved for decorative/banner output, not per-line logs.
const RAINBOW: readonly string[] = [
  '\x1b[38;2;255;182;193m', '\x1b[38;2;255;186;191m', '\x1b[38;2;255;190;189m',
  '\x1b[38;2;255;194;187m', '\x1b[38;2;255;198;185m', '\x1b[38;2;255;202;183m',
  '\x1b[38;2;255;206;181m', '\x1b[38;2;255;210;179m', '\x1b[38;2;255;214;177m',
  '\x1b[38;2;255;218;175m',
  '\x1b[38;2;255;222;173m', '\x1b[38;2;255;226;172m', '\x1b[38;2;255;230;171m',
  '\x1b[38;2;255;234;170m', '\x1b[38;2;255;238;170m', '\x1b[38;2;255;242;170m',
  '\x1b[38;2;255;246;170m', '\x1b[38;2;255;250;170m', '\x1b[38;2;253;252;172m',
  '\x1b[38;2;248;254;174m',
  '\x1b[38;2;243;255;176m', '\x1b[38;2;235;255;178m', '\x1b[38;2;227;255;180m',
  '\x1b[38;2;219;255;182m', '\x1b[38;2;211;255;184m', '\x1b[38;2;203;255;186m',
  '\x1b[38;2;195;255;190m', '\x1b[38;2;190;255;195m', '\x1b[38;2;185;255;200m',
  '\x1b[38;2;180;255;208m',
  '\x1b[38;2;178;255;216m', '\x1b[38;2;176;255;224m', '\x1b[38;2;174;255;232m',
  '\x1b[38;2;172;255;240m', '\x1b[38;2;172;252;248m', '\x1b[38;2;172;248;252m',
  '\x1b[38;2;172;244;255m', '\x1b[38;2;172;238;255m', '\x1b[38;2;174;232;255m',
  '\x1b[38;2;176;226;255m',
  '\x1b[38;2;178;220;255m', '\x1b[38;2;180;214;255m', '\x1b[38;2;182;208;255m',
  '\x1b[38;2;184;202;255m', '\x1b[38;2;186;196;255m', '\x1b[38;2;188;192;255m',
  '\x1b[38;2;190;188;255m', '\x1b[38;2;192;185;255m',
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

// ── Big block-letter font (5x7 dot matrix, uppercase A-Z subset) ──
// Used for the startup logo, in the same spirit as "PC Gaming Redists"'s
// big ASCII-art title: solid fill ('#'), light-shade anti-aliasing on curves
// ('.'), and a light-shade drop-shadow row underneath each letter.
// Add more letters here if the logo text changes.
const BLOCK_FONT: Record<string, string[]> = {
  V: ['#   #', '#   #', '#   #', '#   #', '#   #', '.# #.', '  #  '],
  Y: ['#   #', '#   #', '.# #.', '  #  ', '  #  ', '  #  ', '  #  '],
  B: ['#### ', '#   #', '#   #', '#### ', '#   #', '#   #', '#### '],
  E: ['#####', '#    ', '#    ', '#### ', '#    ', '#    ', '#####'],
  C: [' .###', '#    ', '#    ', '#    ', '#    ', '#    ', ' .###'],
  O: ['.###.', '#   #', '#   #', '#   #', '#   #', '#   #', '.###.'],
  R: ['#### ', '#   #', '#   #', '#### ', '# #  ', '#  # ', '#   #'],
  D: ['#### ', '#   #', '#   #', '#   #', '#   #', '#   #', '#### '],
  ' ': ['     ', '     ', '     ', '     ', '     ', '     ', '     '],
};

/**
 * Render text as big 5x7 block-letter ASCII art with a light-shade drop
 * shadow underneath. Returns one string per row (8 rows: 7 letter + shadow).
 */
export function renderBigText(text: string, scaleX = 2): string[] {
  const rows = 7;
  const lines = new Array(rows + 1).fill('');
  const shadowSegments: string[] = [];
  for (const ch of text.toUpperCase()) {
    const glyph = BLOCK_FONT[ch];
    if (!glyph) continue; // skip characters we don't have a glyph for
    let letterWidth = 0;
    for (let r = 0; r < rows; r++) {
      let seg = '';
      for (const px of glyph[r]) {
        const c = px === '#' ? '█' : px === '.' ? '░' : ' ';
        seg += c.repeat(scaleX);
      }
      letterWidth = seg.length;
      lines[r] += seg + ' '; // 1-column gap between letters
    }
    shadowSegments.push('░'.repeat(letterWidth) + ' ');
  }
  lines[rows] = shadowSegments.join('');
  return lines.map(l => l.trimEnd());
}

/** Write big block-letter text to stdout, rainbow-gradient applied per row. */
export function writeBigRainbow(text: string, scaleX = 2): void {
  for (const line of renderBigText(text, scaleX)) {
    writeRainbow(line);
  }
}

/** Center a line of text within the given width by left-padding with spaces. */
export function centerText(text: string, width: number): string {
  if (text.length >= width) return text;
  return ' '.repeat(Math.floor((width - text.length) / 2)) + text;
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
    debug: `${LEVEL_COLORS.debug}[`,
    info:  `${LEVEL_COLORS.info}[`,
    warn:  `${LEVEL_COLORS.warn}[`,
    error: `${LEVEL_COLORS.error}[`,
  };
  const consoleSuffix: Record<LogLevel, string> = {
    debug: `] [${LEVEL_TAGS.debug}] [${name}]${RESET} `,
    info:  `] [${LEVEL_TAGS.info}] [${name}]${RESET} `,
    warn:  `] [${LEVEL_TAGS.warn}] [${name}]${RESET} `,
    error: `] [${LEVEL_TAGS.error}] [${name}]${RESET} `,
  };
  const fileTag: Record<LogLevel, string> = {
    debug: `] [${LEVEL_TAGS.debug}] [${name}] `,
    info:  `] [${LEVEL_TAGS.info}] [${name}] `,
    warn:  `] [${LEVEL_TAGS.warn}] [${name}] `,
    error: `] [${LEVEL_TAGS.error}] [${name}] `,
  };

  const emit = (level: LogLevel, msg: string) => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[globalLevel]) return;

    const ts = formatTime();

    // Console (colored) — only 3 concats instead of a template literal
    process.stdout.write(consolePrefix[level] + ts + consoleSuffix[level] + msg + '\n');

    // File (buffered)
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
