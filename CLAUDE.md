# Vybecord — notes for Claude

Discord Rich Presence with real-time synced lyrics, as a Windows Electron app.
README.md is the full reference (architecture, config, release checklist);
this file is what every session needs before touching code.

## Working with Sam

- Talk to the user in **French**. Code, comments, commit messages and docs stay in **English**.
- Releases are built from `desktop-app`; `main` is the default branch and deploys the website.
  Feature work happens on its own branch and is merged into `desktop-app`.

## Commands

| Command | Use |
| --- | --- |
| `npm run typecheck` | `tsc --noEmit` over `src/` and `electron/` — must pass |
| `npm run build` | esbuild into `dist-electron/` — must pass |
| `npm run dev` | build + launch (Windows only) |

`/verify` runs every check that works without Windows. `/release` walks the release checklist.

## What cannot be checked here

The media source is a native WinRT addon (`@coooookies/windows-smtc-monitor`) and
`better-sqlite3` is built for Electron's ABI: **the app only runs on Windows**, and
plain `node` cannot load the SQLite stores. In a cloud or Linux session, typecheck
and build are the ceiling. Say so plainly, and list what Sam must click through in
the running app, rather than claiming a UI change works.

There is no automated test suite and no CI for the app.

## Layout

- `electron/` main process: `main.ts`, `ipc.ts` (every channel), `preload.ts` (the renderer's whole API, `window.vybecord`), workers.
- `src/backend.ts` orchestrator: sources → ranking → presence slots → lyrics → Discord. `src/core/` everything else.
- `ui/` renderer: **vanilla JS**, no framework, bundled into one IIFE (`file://` blocks ES modules). One module per page in `ui/src/pages/`.
- A new backend event must be added to **both** `FORWARDED_EVENTS` in `electron/ipc.ts` and `EVENTS` in `electron/preload.ts`.
- A new IPC call needs a handler in `ipc.ts` and an entry in `preload.ts`.

## Conventions

- Commit subject: one English sentence saying what was wrong **from the user's point of view**
  ("Two Twitch tabs were one card flipping between two streams"). Body explains why.
  Release commits: `Release <x.y.z>: <summary>`.
- TypeScript strict, ESM. Comments explain *why* (rejected alternatives, measurements), not what.
- Keep dependencies minimal; nothing may require a C++ toolchain. Electron is pinned on purpose (see README).
- In development the data folder is the repo root. Any new file the app writes there must be
  added to `.gitignore` — `lastfm-session.txt` once nearly leaked a live session key.
- User-facing behaviour changes update `README.md`, `USER_GUIDE.md` **and** `GUIDE_UTILISATEUR.md` (French).

## Current work: UI revamp (branch `ui-revamp*`)

Navigation went from 8 pages to 5: Now, Library, Activity, Settings, Welcome.
`players`, `account`, `history` and `stats` were folded into the others. The Discord card
preview (`ui/src/discord-card.js`) is fed by the `activityUpdate` event. Open items:
`stats:history` IPC has no caller left; the guides still describe Players/History pages;
not yet tested in the running app.
