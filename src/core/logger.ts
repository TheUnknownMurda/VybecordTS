import fs from 'node:fs';
import path from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

const TS_COLOR = '\x1b[38;2;120;128;145m';     // dim slate — timestamp fades into the background
const TS_WIDTH = 12; // "HH:MM:SS.mmm" — used to compute indent width for multi-line messages
const MODULE_COLOR = '\x1b[38;2;178;186;204m'; // neutral slate-blue — module name, same weight at every level
const MODULE_NAME_WIDTH = 14; // fits all current module names except one or two long outliers, which just overflow slightly

// Level "pill" badges — soft pastel background + dark foreground, like a modern
// CLI status chip, instead of plain colored brackets.
const LEVEL_BADGE_BG: Record<LogLevel, string> = {
  debug: '\x1b[48;2;190;188;255m',
  info:  '\x1b[48;2;172;244;255m',
  warn:  '\x1b[48;2;255;246;170m',
  error: '\x1b[48;2;255;140;140m',
};
// A small glyph inside each badge, for scanning a busy log at a glance
// without reading the text — same idea as npm/vite/yarn's status symbols.
const LEVEL_ICONS: Record<LogLevel, string> = {
  debug: '·',
  info:  '●',
  warn:  '▲',
  error: '✕',
};
const BADGE_TEXT = '\x1b[38;2;24;24;36m';   // near-black — stays readable on every pastel background
const SEP_COLOR = '\x1b[38;2;70;76;90m';    // faint column divider, recedes behind the content it separates

// Dedicated badge for the live synced-lyric line — same pill shape as the
// log-level badges, but its own color and not part of LogLevel/priority
// filtering, so it always prints. Sits alongside real logs instead of
// floating as an unformatted raw line that looks "cut off" between them.
const LYRICS_BADGE_BG = '\x1b[48;2;255;180;220m'; // pastel pink — echoes the rainbow's starting hue
const LYRICS_TAG = 'LYRIC';
const LYRICS_ICON = '♪';

const RESET = '\x1b[0m';

// A ✓ or ✗ already shows up throughout the app's own log messages (e.g.
// "Discord RPC connected ✓"). Auto-color just that glyph — cheap fast-path
// check means messages without one pay ~nothing extra.
const SUCCESS_MARK_COLOR = '\x1b[38;2;150;255;180m';
const FAIL_MARK_COLOR = '\x1b[38;2;255;140;140m';
const MARK_RE = /[✓✗✖]/;
function highlightMarks(msg: string): string {
  if (!MARK_RE.test(msg)) return msg;
  return msg.replace(/✓/g, SUCCESS_MARK_COLOR + '✓' + RESET)
             .replace(/[✗✖]/g, m => FAIL_MARK_COLOR + m + RESET);
}

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

/**
 * Console output, and the switch that turns it off for good.
 *
 * A stdout that refuses writes -- the terminal that launched the app closed,
 * output piped to something that has since exited -- fails every write with
 * EPIPE. That escapes the logger and reaches the uncaughtException handler,
 * whose whole job is to log it, straight back into the same broken stream.
 * One real session recorded 4,140 rounds of that in 299ms, and 5 MB of log
 * file holding nothing else.
 *
 * So the first refusal is the last. The log file keeps everything either way,
 * and a console nobody is reading is not worth a loop.
 */
let consoleDead = false;

function writeConsole(text: string, stream: NodeJS.WriteStream = process.stdout): void {
  if (consoleDead) return;
  try {
    stream.write(text);
  } catch {
    consoleDead = true;
  }
}

/** Same guard, for the two places that report the logger own failures. */
function writeConsoleErr(text: string): void {
  writeConsole(text, process.stderr);
}

// Depending on what stdout is attached to, EPIPE arrives as an 'error' event
// rather than a throw. Same verdict -- and with no listener that event is an
// uncaught exception in its own right, which is the loop again by another door.
try {
  process.stdout?.on('error', () => { consoleDead = true; });
  process.stderr?.on('error', () => { consoleDead = true; });
} catch {
  /* no usable stdio on this thread; the guard above covers it */
}

/** Write a rainbow-gradient line to stdout. Log file gets the plain (uncolored) text. */
export function writeRainbow(text: string): void {
  writeConsole(rainbowText(text) + '\n');
  if (logFileStream) {
    logBuffer += text + '\n';
    if (logBuffer.length >= LOG_FLUSH_THRESHOLD) flushLogBuffer();
  }
}

// ── Big block-letter font (5x7 dot matrix, uppercase A-Z subset) ──
// Used for the startup logo, in the same spirit as "PC Gaming Redists"'s
// big ASCII-art title: solid fill ('#'), light-shade anti-aliasing on curves
// ('.'). A dark, offset silhouette copy is composited behind each letter as
// a proper drop shadow (see renderBigText) — light source top-left, shadow
// falls bottom-right, like a beveled/extruded logo rather than a flat fill.
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

const SHADOW_CHAR = '▒'; // marks a shadow-only cell in the plain (uncolored) grid
const SHADOW_COLOR = '\x1b[38;2;40;43;54m'; // dark slate — reads as depth, not noise

/**
 * Render text as big 5x7 block-letter ASCII art with a proper offset drop
 * shadow: a solid dark silhouette of the same letters, shifted down-right,
 * composited *behind* the front layer. Returns one plain-text string per row.
 */
export function renderBigText(text: string, scaleX = 2, shadowDy = 1, shadowDx = 2): string[] {
  const rows = 7;
  const frontLines = new Array(rows).fill('');
  for (const ch of text.toUpperCase()) {
    const glyph = BLOCK_FONT[ch];
    if (!glyph) continue; // skip characters we don't have a glyph for
    for (let r = 0; r < rows; r++) {
      let seg = '';
      for (const px of glyph[r]) {
        const c = px === '#' ? '█' : px === '.' ? '░' : ' ';
        seg += c.repeat(scaleX);
      }
      frontLines[r] += seg + ' '; // 1-column gap between letters
    }
  }
  const totalWidth = Math.max(...frontLines.map(l => l.length));
  const front = frontLines.map(l => l.padEnd(totalWidth, ' '));

  const outRows = rows + shadowDy;
  const outCols = totalWidth + shadowDx;
  const out: string[] = [];
  for (let r = 0; r < outRows; r++) {
    let line = '';
    for (let c = 0; c < outCols; c++) {
      const frontCh = (r < rows && c < totalWidth) ? front[r][c] : ' ';
      if (frontCh !== ' ') { line += frontCh; continue; }
      const sr = r - shadowDy, sc = c - shadowDx;
      const shadowSrc = (sr >= 0 && sr < rows && sc >= 0 && sc < totalWidth) ? front[sr][sc] : ' ';
      line += shadowSrc !== ' ' ? SHADOW_CHAR : ' ';
    }
    out.push(line.trimEnd());
  }
  return out;
}

/**
 * Write the big block-letter logo: front layer gets the rainbow gradient
 * (by column position), the offset shadow layer gets a flat dark color —
 * composited together per line since a single writeRainbow() pass can't
 * mix two different color rules on the same row.
 */
export function writeBigRainbow(text: string, scaleX = 2): void {
  const lines = renderBigText(text, scaleX);
  const width = Math.max(...lines.map(l => l.length));
  for (const line of lines) {
    let colored = '';
    for (let c = 0; c < line.length; c++) {
      const ch = line[c];
      if (ch === ' ') { colored += ' '; continue; }
      if (ch === SHADOW_CHAR) { colored += SHADOW_COLOR + '█' + RESET; continue; }
      let idx = Math.floor((c / width) * RAINBOW.length);
      if (idx >= RAINBOW.length) idx = RAINBOW.length - 1;
      colored += RAINBOW[idx] + ch + RESET;
    }
    writeConsole(colored + '\n');
    if (logFileStream) {
      logBuffer += line + '\n'; // plain text (no ANSI) in the log file
      if (logBuffer.length >= LOG_FLUSH_THRESHOLD) flushLogBuffer();
    }
  }
}

/** Center a line of text within the given width by left-padding with spaces. */
export function centerText(text: string, width: number): string {
  if (text.length >= width) return text;
  return ' '.repeat(Math.floor((width - text.length) / 2)) + text;
}

/**
 * Print a thin rainbow-gradient divider with a centered label, e.g. to mark
 * the start of a new phase ("Startup", "Shutting down") in a busy log.
 */
export function writeSection(title: string, width = 70): void {
  const label = ` ${title} `;
  if (label.length >= width) { writeRainbow(label); return; }
  const leftLen = Math.floor((width - label.length) / 2);
  const rightLen = width - label.length - leftLen;
  writeRainbow('─'.repeat(leftLen) + label + '─'.repeat(rightLen));
}

let globalLevel: LogLevel = 'info';
let logFileStream: fs.WriteStream | null = null;

/**
 * Where log lines go instead of this thread's console and log file.
 *
 * A worker thread has neither: its stdout is forwarded to the parent's console
 * but never reaches the log file, so anything it reports is missing from the one
 * place anyone looks afterwards. Installing a sink lets it hand its lines to the
 * main thread, which logs them normally. Null on the main thread itself.
 */
let logSink: ((level: LogLevel, name: string, msg: string) => void) | null = null;

export function setLogLevel(level: LogLevel): void {
  globalLevel = level;
}

/** Redirect this thread's log output — see logSink. Pass null to restore normal output. */
export function setLogSink(sink: ((level: LogLevel, name: string, msg: string) => void) | null): void {
  logSink = sink;
}

const MAX_LOG_SIZE = 5 * 1024 * 1024; // 5 MB — rotate when exceeded

/** Where the log lives, kept so rotation can run without being handed it again. */
let logDir = '';
let logPathCurrent = '';
/**
 * Bytes in the current log file: what it held when it was opened, plus
 * everything handed to the stream since.
 *
 * Counted rather than stat'ed. A WriteStream queues in memory and drains on the
 * event loop, so the file on disk trails what has actually been logged —
 * statting it reports a size that is minutes stale under load, which is exactly
 * when rotation matters. Counting is also free, where a stat per flush is not.
 */
let logBytesWritten = 0;
/** True while the file is being moved and there is no stream to write to. */
let rotating = false;

/**
 * Roll the log over once it passes the cap.
 *
 * Rotation used to happen only in initLogFile, which is to say once per launch.
 * This app's whole shape is to sit in the tray for days, and it writes a line
 * per lyric — so the one process that most needed rotating was the one that
 * never got it, and the 5 MB cap only ever applied to whatever the *previous*
 * session had left behind. Checked against a byte counter rather than on every
 * line, so the common path costs an addition.
 *
 * The rename waits for 'close', not 'finish': 'finish' fires when the last
 * write is handed over, while the descriptor is still open, and Windows refuses
 * to rename a file that something still holds. Meanwhile `logFileStream` is
 * null, which makes flushLogBuffer leave the buffer alone — so the lines
 * written during the move are queued rather than lost, and go out with the
 * flush at the end.
 */
function maybeRotate(): void {
  if (rotating || !logFileStream || !logPathCurrent || logBytesWritten <= MAX_LOG_SIZE) return;

  rotating = true;
  const stream = logFileStream;
  logFileStream = null;
  stream.once('close', () => {
    try {
      rotateFile(logDir, logPathCurrent);
      logBytesWritten = 0;
    } catch (e) {
      // Could not move it — reopen the same file rather than stopping. An
      // oversized log beats a silent one, but the counter must not stay over
      // the cap or every flush from here on would try to rotate again.
      writeConsoleErr(`[Logger] Could not rotate the log: ${(e as Error).message}\n`);
      logBytesWritten = 0;
    }
    logFileStream = openLogStream(logPathCurrent);
    rotating = false;
    flushLogBuffer();
  });
  stream.end();
}

/** Move the current log aside, replacing any previous archive. */
function rotateFile(dir: string, logPath: string): void {
  const oldPath = path.join(dir, 'vybecord.old.log');
  if (fs.existsSync(oldPath)) fs.unlinkSync(oldPath);
  fs.renameSync(logPath, oldPath);
}

function openLogStream(logPath: string): fs.WriteStream {
  const stream = fs.createWriteStream(logPath, { flags: 'a' });
  stream.on('error', (err) => {
    // Disable file logging on write error (disk full, permission, etc.)
    writeConsoleErr(`[Logger] File write error: ${err.message}\n`);
    if (logFileStream === stream) logFileStream = null;
  });
  return stream;
}

export function initLogFile(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const logPath = path.join(dir, 'vybecord.log');
  logDir = dir;
  logPathCurrent = logPath;

  // Rotate if the log left by the previous session exceeds max size, and start
  // the byte count from whatever it is carrying over — a session that appends
  // to a 4 MB log has 1 MB of headroom, not 5.
  logBytesWritten = 0;
  try {
    if (fs.existsSync(logPath)) {
      const carried = fs.statSync(logPath).size;
      if (carried > MAX_LOG_SIZE) rotateFile(dir, logPath);
      else logBytesWritten = carried;
    }
  } catch { /* ignore rotation errors */ }

  logFileStream = openLogStream(logPath);

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
  const chunk = logBuffer;
  logBuffer = '';
  logFileStream.write(chunk);
  // byteLength, not length: a log of lyrics is full of multi-byte characters,
  // and counting UTF-16 units would let the file grow well past the cap.
  logBytesWritten += Buffer.byteLength(chunk, 'utf-8');
  maybeRotate();
}

/** Flush remaining buffer and close the log file. Call before process.exit(). */
export function flushAndClose(): void {
  if (logFlushTimer) { clearInterval(logFlushTimer); logFlushTimer = null; }
  flushLogBuffer();
  // A rotation caught mid-flight leaves no stream to flush into, and the caller
  // is on its way to process.exit — so write the tail straight to the file
  // rather than dropping the last thing the app had to say.
  if (logBuffer && logPathCurrent) {
    try {
      fs.appendFileSync(logPathCurrent, logBuffer);
      logBuffer = '';
    } catch { /* nothing further to try on the way out */ }
  }
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

// Strips ANSI escape codes to measure the real on-screen width of a string —
// used once per logger (not per log call) to size the multi-line indent.
const ANSI_RE = /\x1b\[[0-9;]*m/g;
function visibleLength(s: string): number {
  return s.replace(ANSI_RE, '').length;
}

export function createLogger(name: string) {
  // Pad every module name to the same width so the message always starts
  // at the same column, regardless of whether the name is "Main" or
  // "SoundCloudSource". Names longer than the budget are left as-is.
  const paddedName = name.length < MODULE_NAME_WIDTH ? name.padEnd(MODULE_NAME_WIDTH, ' ') : name;
  const sep = `${SEP_COLOR}│${RESET}`;

  // Pre-build the badge + separator + module-tag chunk per level (constant
  // after construction — avoids rebuilding it on every single log call).
  const mid: Record<LogLevel, string> = {
    debug: `${LEVEL_BADGE_BG.debug}${BADGE_TEXT} ${LEVEL_ICONS.debug} ${LEVEL_TAGS.debug} ${RESET} ${sep} ${MODULE_COLOR}${paddedName}${RESET} ${sep} `,
    info:  `${LEVEL_BADGE_BG.info}${BADGE_TEXT} ${LEVEL_ICONS.info} ${LEVEL_TAGS.info} ${RESET} ${sep} ${MODULE_COLOR}${paddedName}${RESET} ${sep} `,
    warn:  `${LEVEL_BADGE_BG.warn}${BADGE_TEXT} ${LEVEL_ICONS.warn} ${LEVEL_TAGS.warn} ${RESET} ${sep} ${MODULE_COLOR}${paddedName}${RESET} ${sep} `,
    error: `${LEVEL_BADGE_BG.error}${BADGE_TEXT} ${LEVEL_ICONS.error} ${LEVEL_TAGS.error} ${RESET} ${sep} ${MODULE_COLOR}${paddedName}${RESET} ${sep} `,
  };
  const fileMid: Record<LogLevel, string> = {
    debug: `${LEVEL_TAGS.debug} | ${paddedName} | `,
    info:  `${LEVEL_TAGS.info} | ${paddedName} | `,
    warn:  `${LEVEL_TAGS.warn} | ${paddedName} | `,
    error: `${LEVEL_TAGS.error} | ${paddedName} | `,
  };
  const lyricsMid = `${LYRICS_BADGE_BG}${BADGE_TEXT} ${LYRICS_ICON} ${LYRICS_TAG} ${RESET} ${sep} ${MODULE_COLOR}${paddedName}${RESET} ${sep} `;

  // Visible (non-ANSI) width of "{ts} {badge...module...}" measured once,
  // so a message with embedded newlines can have its continuation lines
  // indented to the same column instead of breaking the layout.
  const consoleIndent = ' '.repeat(TS_WIDTH + 1 + visibleLength(mid.info));
  const fileIndent = ' '.repeat(TS_WIDTH + 3 + fileMid.info.length);

  const emit = (level: LogLevel, msg: string) => {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[globalLevel]) return;

    if (logSink) {
      // The sink owns formatting and destination; a thread with one has no
      // console or log file of its own worth writing to.
      logSink(level, name, msg);
      return;
    }

    const ts = formatTime();
    const marked = highlightMarks(msg);

    // Console: dim timestamp, pastel badge chip, faint separators, neutral module tag, plain message
    if (marked.indexOf('\n') === -1) {
      writeConsole(TS_COLOR + ts + RESET + ' ' + mid[level] + marked + '\n');
    } else {
      const msgLines = marked.split('\n');
      let out = TS_COLOR + ts + RESET + ' ' + mid[level] + msgLines[0] + '\n';
      for (let i = 1; i < msgLines.length; i++) out += consoleIndent + msgLines[i] + '\n';
      writeConsole(out);
    }

    // File (buffered, uncolored, pipe-separated so it's still easy to scan or grep)
    if (logFileStream) {
      if (msg.indexOf('\n') === -1) {
        logBuffer += ts + ' | ' + fileMid[level] + msg + '\n';
      } else {
        const msgLines = msg.split('\n');
        logBuffer += ts + ' | ' + fileMid[level] + msgLines[0] + '\n';
        for (let i = 1; i < msgLines.length; i++) logBuffer += fileIndent + msgLines[i] + '\n';
      }
      if (logBuffer.length >= LOG_FLUSH_THRESHOLD) flushLogBuffer();
    }
  };

  return {
    debug: (msg: string) => emit('debug', msg),
    info: (msg: string) => emit('info', msg),
    warn: (msg: string) => emit('warn', msg),
    error: (msg: string) => emit('error', msg),
    raw: (msg: string) => {
      writeConsole(msg + '\n');
      if (logFileStream) {
        logBuffer += msg + '\n';
        if (logBuffer.length >= LOG_FLUSH_THRESHOLD) flushLogBuffer();
      }
    },
    // Live synced-lyric line: same timestamp/badge/module columns as a real
    // log line (so it never looks like a stray line dropped between two
    // logs), but the message itself keeps the rainbow gradient. Always
    // prints — bypasses level filtering, like raw().
    lyrics: (msg: string) => {
      const ts = formatTime();
      writeConsole(TS_COLOR + ts + RESET + ' ' + lyricsMid + rainbowText(msg) + '\n');
      if (logFileStream) {
        logBuffer += ts + ' | ' + LYRICS_TAG + ' | ' + paddedName + ' | ' + msg + '\n';
        if (logBuffer.length >= LOG_FLUSH_THRESHOLD) flushLogBuffer();
      }
    },
  };
}

export type Logger = ReturnType<typeof createLogger>;