/**
 * Discord IPC connections, one per application ID, shared by every presence.
 *
 * A presence card is identified by the Discord application it is published
 * under — that is what puts "Spotify" or "YouTube" on the card. Switching what
 * a presence shows therefore used to mean closing its socket and opening a new
 * one under the next application, which is exactly the kind of churn Discord
 * throttles: a few quick reconnects and it stops accepting connections for tens
 * of seconds.
 *
 * With two presences on air that churn would double, and it would happen at
 * the worst moment. Presence 1 is the highest-priority thing playing, so when a
 * song starts under a video the video moves from card 1 to card 2. Per-presence
 * sockets would reconnect both. Keyed by application instead, the video keeps
 * the socket it already had and the song opens one — and a socket nobody uses
 * any more is cleared at once and closed only after a grace, so flipping back
 * within it costs nothing.
 *
 * Nothing here decides what to publish. A presence acquires the connection for
 * its application, publishes through it, and releases it when it moves on.
 */

import { DiscordIPC } from './discord-ipc.js';
import { createLogger } from './logger.js';

const log = createLogger('DiscordPool');

/** How long an unused connection is kept before it is closed. */
const IDLE_CLOSE_MS = 60_000;
/** Ceiling on open sockets; the least recently released idle one goes first. */
const MAX_CONNECTIONS = 4;

interface Entry {
  ipc: DiscordIPC;
  /** Presences currently publishing through this connection. */
  users: Set<number>;
  /** When the last user let go; 0 while in use. */
  idleSince: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

export class DiscordPool {
  private entries = new Map<string, Entry>();
  private closing = false;

  /**
   * @param onReady  a connection reached READY — the presences on it should
   *   republish, because a fresh socket knows nothing of what they show.
   * @param onStatus  connectivity changed one way or the other.
   */
  constructor(
    private readonly onReady: (appId: string) => void,
    private readonly onStatus: () => void,
  ) {}

  /** The connection for this application, opened if need be, now used by `user`. */
  acquire(appId: string, user: number): DiscordIPC {
    let entry = this.entries.get(appId);
    if (!entry) {
      this.makeRoom();
      const ipc = new DiscordIPC(appId);
      entry = { ipc, users: new Set(), idleSince: 0, idleTimer: null };
      this.entries.set(appId, entry);
      this.wire(appId, ipc);
      if (!this.closing) {
        ipc.connectWithRetry().catch(e => log.error(`Discord connection failed: ${e}`));
      }
    }
    entry.users.add(user);
    if (entry.idleTimer) {
      clearTimeout(entry.idleTimer);
      entry.idleTimer = null;
    }
    entry.idleSince = 0;
    return entry.ipc;
  }

  /**
   * `user` no longer publishes through this application.
   *
   * The card comes down immediately when nobody else is on the connection —
   * a presence that moved to another application must not leave its old card
   * behind — but the socket itself stays open for a while, so the same
   * application coming straight back is a republish rather than a reconnect.
   */
  release(appId: string, user: number): void {
    const entry = this.entries.get(appId);
    if (!entry) return;
    entry.users.delete(user);
    if (entry.users.size) return;
    entry.ipc.clearActivity().catch(() => {});
    entry.idleSince = Date.now();
    if (!entry.idleTimer) {
      entry.idleTimer = setTimeout(() => {
        entry!.idleTimer = null;
        if (entry!.users.size) return;
        this.drop(appId);
      }, IDLE_CLOSE_MS);
      entry.idleTimer.unref?.();
    }
  }

  /** The connection for this application, if one is open. */
  get(appId: string): DiscordIPC | undefined {
    return this.entries.get(appId)?.ipc;
  }

  isConnected(appId: string): boolean {
    return this.entries.get(appId)?.ipc.isConnected ?? false;
  }

  /** Whether any connection is up — what the window's status dot reports. */
  get anyConnected(): boolean {
    for (const e of this.entries.values()) if (e.ipc.isConnected) return true;
    return false;
  }

  /** Every application with an open connection. */
  appIds(): string[] {
    return [...this.entries.keys()];
  }

  /** Close everything, waiting for each card to come down first. */
  async closeAll(): Promise<void> {
    this.closing = true;
    const all = [...this.entries.entries()];
    this.entries.clear();
    await Promise.all(all.map(async ([, e]) => {
      if (e.idleTimer) clearTimeout(e.idleTimer);
      await e.ipc.gracefulClose();
    }));
  }

  private wire(appId: string, ipc: DiscordIPC): void {
    ipc.onReady(() => {
      // Superseded by a newer connection under the same id — drop it.
      if (this.entries.get(appId)?.ipc !== ipc) {
        ipc.close();
        return;
      }
      log.info(`Discord RPC connected (${appId}) ✓`);
      this.onReady(appId);
      this.onStatus();
    });
    ipc.onDisconnect(() => {
      if (this.entries.get(appId)?.ipc !== ipc) return;
      log.warn(`Discord disconnected (${appId}) — will retry`);
      this.onStatus();
    });
  }

  /** Evict the longest-idle connection when the ceiling is reached. */
  private makeRoom(): void {
    if (this.entries.size < MAX_CONNECTIONS) return;
    let victim: string | null = null;
    let oldest = Infinity;
    for (const [id, e] of this.entries) {
      if (e.users.size) continue;
      if (e.idleSince < oldest) { oldest = e.idleSince; victim = id; }
    }
    if (victim) this.drop(victim);
  }

  private drop(appId: string): void {
    const entry = this.entries.get(appId);
    if (!entry) return;
    this.entries.delete(appId);
    if (entry.idleTimer) clearTimeout(entry.idleTimer);
    entry.ipc.close();
    log.info(`Closed idle Discord connection (${appId})`);
  }
}
