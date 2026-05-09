/**
 * Minimal Discord IPC client — zero external dependencies.
 * Communicates via named pipes (Windows) or Unix sockets.
 * Only implements: connect, setActivity, clearActivity, close.
 */

import net from 'node:net';
import { randomUUID } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import { createLogger } from './logger.js';
import type { DiscordActivity } from './types.js';

const log = createLogger('DiscordIPC');

const enum Opcode {
  HANDSHAKE = 0,
  FRAME = 1,
  CLOSE = 2,
  PING = 3,
  PONG = 4,
}

interface IpcMessage {
  opcode: number;
  data: Record<string, unknown>;
}

/** Strip control chars that Discord's JSON parser rejects (U+0000–001F, U+007F–009F, line/para separators). */
const RE_CONTROL = /[\x00-\x1f\x7f-\x9f\u2028\u2029]/g;
function sanitize(s: string): string { return s.replace(RE_CONTROL, ''); }

/** Discord requires details/state to be at least 2 characters — pad with a trailing space if needed. */
function padMin2(s: string): string { return s.length < 2 ? s + ' ' : s; }

export class DiscordIPC {
  private socket: net.Socket | null = null;
  private clientId: string;
  private readBuffer = Buffer.allocUnsafe(4096);
  private readLen = 0;   // valid bytes in readBuffer
  private readOffset = 0; // consumed bytes (leading slack)
  private pendingResolves: Map<string, { resolve: (data: unknown) => void; reject: (err: Error) => void; timer: ReturnType<typeof setTimeout> }> = new Map();
  private connected = false;
  private _onReady?: () => void;
  private _onError?: (err: Error) => void;
  private _onDisconnect?: () => void;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private shouldReconnect = true;

  // Hot-path optimization: monotonic nonce counter (cheaper than randomUUID)
  private nonceCounter = 0;
  // Cached setActivity state: skip full rebuild + JSON.stringify when activity unchanged
  private lastActivityJson = '';
  private lastActivityArgs = '';
  private readonly pid = process.pid;

  constructor(clientId: string) {
    this.clientId = clientId;
  }

  onReady(cb: () => void): this { this._onReady = cb; return this; }
  onError(cb: (err: Error) => void): this { this._onError = cb; return this; }
  onDisconnect(cb: () => void): this { this._onDisconnect = cb; return this; }

  get isConnected(): boolean { return this.connected; }

  // ── Connection ──

  async connect(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      try {
        await this.tryPipe(i);
        await this.handshake();
        this.setupSocketHandlers();
        this.connected = true;
        log.info(`Connected to Discord IPC pipe ${i}`);
        this._onReady?.();
        return;
      } catch {
        // Destroy socket from failed attempt before trying next pipe
        if (this.socket) {
          this.socket.removeAllListeners();
          this.socket.destroy();
          this.socket = null;
        }
      }
    }
    throw new Error('Could not connect to Discord — is Discord running?');
  }

  async connectWithRetry(intervalMs = 5000): Promise<void> {
    this.shouldReconnect = true;
    while (this.shouldReconnect) {
      try {
        await this.connect();
        return;
      } catch (e) {
        log.warn(`Discord not available, retrying in ${intervalMs / 1000}s...`);
        await new Promise(r => {
          this.reconnectTimer = setTimeout(r, intervalMs);
        });
      }
    }
  }

  private tryPipe(n: number): Promise<void> {
    return new Promise((resolve, reject) => {
      const pipePath = process.platform === 'win32'
        ? `\\\\?\\pipe\\discord-ipc-${n}`
        : `/tmp/discord-ipc-${n}`;

      const sock = net.createConnection(pipePath);
      const timeout = setTimeout(() => {
        sock.destroy();
        reject(new Error('Connection timeout'));
      }, 2000);

      sock.once('connect', () => {
        clearTimeout(timeout);
        this.socket = sock;
        this.readLen = 0;
        this.readOffset = 0;
        resolve();
      });

      sock.once('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private setupSocketHandlers(): void {
    if (!this.socket) return;

    this.socket.on('data', (chunk: Buffer) => {
      // Grow buffer if needed, then copy chunk in-place (avoids Buffer.concat alloc)
      const needed = this.readLen + chunk.length;
      if (needed > this.readBuffer.length) {
        // Compact first: shift valid data to front, then resize if still insufficient
        if (this.readOffset > 0) {
          this.readBuffer.copyWithin(0, this.readOffset, this.readLen);
          this.readLen -= this.readOffset;
          this.readOffset = 0;
        }
        if (this.readLen + chunk.length > this.readBuffer.length) {
          const newBuf = Buffer.allocUnsafe(Math.max(this.readBuffer.length * 2, this.readLen + chunk.length));
          this.readBuffer.copy(newBuf, 0, 0, this.readLen);
          this.readBuffer = newBuf;
        }
      }
      chunk.copy(this.readBuffer, this.readLen);
      this.readLen += chunk.length;
      this.processBuffer();
    });

    this.socket.on('close', () => {
      this.connected = false;
      this.rejectPending('IPC disconnected');
      log.warn('Discord IPC disconnected');
      this._onDisconnect?.();
      if (this.shouldReconnect) {
        this.scheduleReconnect();
      }
    });

    this.socket.on('error', (err) => {
      log.error(`IPC socket error: ${err.message}`);
      this._onError?.(err);
    });
  }

  /** Reject all pending request promises (socket closed/disconnected). */
  private rejectPending(reason: string): void {
    if (this.pendingResolves.size === 0) return;
    const err = new Error(reason);
    for (const [, entry] of this.pendingResolves) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this.pendingResolves.clear();
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(async () => {
      this.reconnectTimer = null;
      try {
        await this.connect();
      } catch {
        this.scheduleReconnect();
      }
    }, 5000);
  }

  private processBuffer(): void {
    const buf = this.readBuffer;
    while (this.readLen - this.readOffset >= 8) {
      const opcode = buf.readUInt32LE(this.readOffset);
      const length = buf.readUInt32LE(this.readOffset + 4);
      const frameEnd = this.readOffset + 8 + length;

      if (this.readLen < frameEnd) break; // Incomplete frame

      const payload = buf.toString('utf-8', this.readOffset + 8, frameEnd);
      this.readOffset = frameEnd;

      try {
        const data = JSON.parse(payload) as Record<string, unknown>;
        this.handleMessage(opcode, data);
      } catch (e) {
        log.error(`Failed to parse IPC message: ${e}`);
      }
    }

    // Compact when >50% consumed (amortized — avoids copy on every frame)
    if (this.readOffset > 0 && this.readOffset >= (this.readLen >> 1)) {
      buf.copyWithin(0, this.readOffset, this.readLen);
      this.readLen -= this.readOffset;
      this.readOffset = 0;
    }
  }

  private handleMessage(opcode: number, data: Record<string, unknown>): void {
    if (opcode === Opcode.PING) {
      this.send(Opcode.PONG, data).catch(() => {});
      return;
    }

    if (opcode === Opcode.CLOSE) {
      log.warn(`Discord sent CLOSE: ${JSON.stringify(data)}`);
      this.socket?.destroy();
      return;
    }

    // Log Discord errors (SET_ACTIVITY rejections, etc.)
    const evt = data.evt as string | undefined;
    if (evt === 'ERROR' || (data.data as Record<string, unknown>)?.code) {
      log.warn(`Discord IPC error: ${JSON.stringify(data)}`);
    }

    // Resolve pending request by nonce
    const nonce = data.nonce as string | undefined;
    if (nonce && this.pendingResolves.has(nonce)) {
      const entry = this.pendingResolves.get(nonce)!;
      clearTimeout(entry.timer);
      this.pendingResolves.delete(nonce);
      entry.resolve(data);
    }
  }

  // ── Framing ──

  private send(opcode: number, data: unknown): Promise<void> {
    return new Promise((resolve, reject) => {
      if (!this.socket || this.socket.destroyed) {
        return reject(new Error('Not connected'));
      }
      const json = JSON.stringify(data);
      const len = Buffer.byteLength(json, 'utf-8');
      const buf = Buffer.allocUnsafe(8 + len);
      buf.writeUInt32LE(opcode, 0);
      buf.writeUInt32LE(len, 4);
      buf.write(json, 8, 'utf-8');
      this.socket.write(buf, (err) => (err ? reject(err) : resolve()));
    });
  }

  /** Fire-and-forget write: no Promise allocation, no nonce tracking. */
  private sendFast(opcode: number, json: string): void {
    const sock = this.socket;
    if (!sock || sock.destroyed) return;
    const len = Buffer.byteLength(json, 'utf-8');
    const buf = Buffer.allocUnsafe(8 + len);
    buf.writeUInt32LE(opcode, 0);
    buf.writeUInt32LE(len, 4);
    buf.write(json, 8, 'utf-8');
    const t0 = performance.now();
    sock.write(buf, () => {
      this._lastWriteLatencyMs = performance.now() - t0;
    });
  }

  private request(opcode: number, data: Record<string, unknown>, timeoutMs = 5000): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const nonce = (data.nonce as string) ?? randomUUID();
      data.nonce = nonce;

      const timer = setTimeout(() => {
        this.pendingResolves.delete(nonce);
        reject(new Error(`IPC request timeout (${timeoutMs}ms)`));
      }, timeoutMs);

      this.pendingResolves.set(nonce, { resolve, reject, timer });

      this.send(opcode, data).catch((err) => {
        clearTimeout(timer);
        this.pendingResolves.delete(nonce);
        reject(err);
      });
    });
  }

  // ── Discord commands ──

  private async handshake(): Promise<void> {
    const data = { v: 1, client_id: this.clientId };
    await this.send(Opcode.HANDSHAKE, data);
    // Wait for DISPATCH READY
    await new Promise<void>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        // Append chunk using the shared offset-based buffer
        if (this.readLen + chunk.length > this.readBuffer.length) {
          const newBuf = Buffer.allocUnsafe(Math.max(this.readBuffer.length * 2, this.readLen + chunk.length));
          this.readBuffer.copy(newBuf, 0, this.readOffset, this.readLen);
          this.readLen -= this.readOffset;
          this.readOffset = 0;
          this.readBuffer = newBuf;
        }
        chunk.copy(this.readBuffer, this.readLen);
        this.readLen += chunk.length;

        while (this.readLen - this.readOffset >= 8) {
          const op = this.readBuffer.readUInt32LE(this.readOffset);
          const len = this.readBuffer.readUInt32LE(this.readOffset + 4);
          const frameEnd = this.readOffset + 8 + len;
          if (this.readLen < frameEnd) return;
          const payload = JSON.parse(this.readBuffer.toString('utf-8', this.readOffset + 8, frameEnd));
          this.readOffset = frameEnd;
          if (op === Opcode.FRAME && payload.evt === 'READY') {
            clearTimeout(timeout);
            this.socket!.removeListener('data', onData);
            resolve();
            return;
          }
        }
      };
      const timeout = setTimeout(() => {
        this.socket?.removeListener('data', onData);
        reject(new Error('Handshake timeout'));
      }, 5000);
      this.socket!.on('data', onData);
    });
  }

  /**
   * Set Discord Rich Presence activity.
   * This is the hot-path — called on every lyric line change.
   * Optimized: builds JSON string directly to avoid intermediate object allocations.
   */
  setActivity(activity: DiscordActivity): void {
    if (!this.connected) return;

    // Build the RPC activity object (Discord IPC SET_ACTIVITY format)
    const rpcActivity: Record<string, unknown> = {};
    if (activity.type != null) rpcActivity.type = activity.type;
    // Discord requires details/state to be at least 2 characters — pad if needed
    if (activity.details) rpcActivity.details = padMin2(sanitize(activity.details));
    if (activity.state) rpcActivity.state = padMin2(sanitize(activity.state));
    if (activity.timestamps) rpcActivity.timestamps = activity.timestamps;

    if (activity.assets) {
      const a = activity.assets;
      const assets: Record<string, string> = {};
      // Always set large_image (use default if not provided to avoid app logo)
      assets.large_image = a.large_image || 'https://images.guns.lol/2d34137430fbdf92ffab3a07ade119c29de30536/zkR9FspOnC79sb6532RdH.gif';
      if (a.large_text) assets.large_text = sanitize(a.large_text);
      if (a.small_image) assets.small_image = a.small_image;
      if (a.small_text) assets.small_text = sanitize(a.small_text);
      rpcActivity.assets = assets;
    }

    if (activity.buttons?.length) {
      rpcActivity.buttons = activity.buttons.map(b => ({
        label: sanitize(b.label), url: b.url,
      }));
      const meta: Record<string, unknown> = {
        button_urls: activity.buttons.map(b => b.url),
      };
      if (activity.large_url) meta.large_image_url = activity.large_url;
      rpcActivity.metadata = meta;
    } else if (activity.large_url) {
      rpcActivity.metadata = { large_image_url: activity.large_url };
    }

    if (activity.details_url) rpcActivity.details_url = activity.details_url;
    if (activity.state_url) rpcActivity.state_url = activity.state_url;

    // Serialize the activity body; skip full re-stringify if unchanged (heartbeats)
    const activityJson = JSON.stringify(rpcActivity);
    const nonce = `sa-${++this.nonceCounter}`;
    let payload: string;
    if (activityJson === this.lastActivityJson) {
      // Reuse cached args portion, only swap nonce
      payload = `{"cmd":"SET_ACTIVITY","args":${this.lastActivityArgs},"nonce":"${nonce}"}`;
    } else {
      this.lastActivityJson = activityJson;
      this.lastActivityArgs = `{"pid":${this.pid},"activity":${activityJson}}`;
      payload = `{"cmd":"SET_ACTIVITY","args":${this.lastActivityArgs},"nonce":"${nonce}"}`;
    }
    this.sendFast(Opcode.FRAME, payload);
  }

  /** Last measured IPC pipe write latency in ms (for lyrics-engine EMA). */
  get lastWriteLatencyMs(): number { return this._lastWriteLatencyMs; }
  private _lastWriteLatencyMs = 0;

  async clearActivity(): Promise<void> {
    if (!this.connected) return;
    // Use request() to wait for Discord's ACK (not just the write callback).
    // Short timeout — if Discord doesn't respond, we still proceed with shutdown.
    await this.request(Opcode.FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid },
    }, 1500).catch(() => {});
  }

  /**
   * Graceful shutdown: clear presence, wait for Discord to process, then close.
   * Use this instead of clearActivity() + close() during shutdown.
   */
  async gracefulClose(): Promise<void> {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.connected && this.socket) {
      // Send clear and wait for Discord's response
      await this.clearActivity();
      // Extra drain time — let the IPC pipe fully flush
      await new Promise(r => setTimeout(r, 250));
    }
    this.closeSocket();
  }

  close(): void {
    this.shouldReconnect = false;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.closeSocket();
  }

  private closeSocket(): void {
    if (this.socket) {
      const sock = this.socket;
      this.socket = null;
      sock.end(() => sock.destroy());
      setTimeout(() => { if (!sock.destroyed) sock.destroy(); }, 500);
    }
    this.connected = false;
    this.rejectPending('IPC closed');
  }
}
