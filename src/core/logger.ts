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
  debug: '\x1b[37m',  // white
  info: '\x1b[32m',   // light green
  warn: '\x1b[33m',   // yellow
  error: '\x1b[34m',  // light blue
};

const RESET = '\x1b[0m';

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
