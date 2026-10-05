---
name: verify
description: Run every Vybecord check that works without launching the app (typecheck, build, renderer syntax and imports, IPC wiring), then list what still needs testing in the running app on Windows. Use before every commit and whenever asked whether a change works.
---

Run these from the repo root and report each result; stop and fix on the first failure.

1. `npm run typecheck`
2. `npm run build`
3. Renderer syntax — the UI is plain JS that tsc does not see:
   `for f in ui/src/*.js ui/src/pages/*.js; do node --check "$f" || exit 1; done`
4. Renderer imports resolve:
   `for f in ui/src/*.js ui/src/pages/*.js; do grep -oE "from '\.\.?/[^']+'" "$f" | sed "s/from '//;s/'//" | while read p; do [ -f "$(dirname "$f")/$p" ] || echo "MISSING $f -> $p"; done; done`
5. IPC wiring — every `api.<name>` used in `ui/src` exists in `electron/preload.ts`, and every
   event the backend emits for the window is in both `FORWARDED_EVENTS` (`electron/ipc.ts`)
   and `EVENTS` (`electron/preload.ts`). Flag preload entries no renderer code calls any more.
6. `git status --short` — nothing from the user-data list in `.gitignore` is staged.

Then write, in French, a short **"À tester dans l'app"** checklist specific to the diff:
which page to open, what to play, what the Discord card should show. The app only runs on
Windows, so never claim a UI change works from these checks alone.
