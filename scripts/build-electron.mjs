/**
 * Build the Electron app into dist-electron/.
 *
 *   main.mjs     ESM bundle of the main process (Electron loads ESM natively)
 *   preload.js   CJS bundle — preload is the one place CJS is still the safe bet
 *   ui/          renderer assets, copied verbatim
 *
 * Run with --watch to rebuild on change.
 */

import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outDir = path.join(root, 'dist-electron');
const watch = process.argv.includes('--watch');

/**
 * The maintainer's bug-report webhook, baked into the main bundle.
 *
 * It has to be compiled in rather than read at runtime: envs/.env is loaded
 * from the user-data folder, which on an installed copy is empty, so a packaged
 * app would have no webhook at all and the Report page would be dead for
 * everyone but the developer.
 *
 * Set it in envs/.env (gitignored) or as an environment variable before
 * building. Left unset, reporting simply stays off and the page says so —
 * a fork building from source does not silently post to someone else's server.
 *
 * Note this is not a secret once shipped: anyone can read it out of the asar.
 * Use a channel you are happy to have publicly writable, and regenerate the
 * webhook in Discord if it is ever abused.
 */
function bugReportWebhook() {
  if (process.env.BUG_REPORT_WEBHOOK) return process.env.BUG_REPORT_WEBHOOK.trim();
  try {
    const env = fs.readFileSync(path.join(root, 'envs', '.env'), 'utf8');
    for (const raw of env.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line.startsWith('BUG_REPORT_WEBHOOK=')) continue;
      return line.slice(line.indexOf('=') + 1).trim()
        .replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no envs/.env — reporting stays off */
  }
  return '';
}

const WEBHOOK = bugReportWebhook();
console.log(WEBHOOK
  ? '[env] bug-report webhook compiled in'
  : '[env] no BUG_REPORT_WEBHOOK — in-app reporting will be disabled in this build');

/**
 * Packages left out of the bundle.
 *
 * The two native addons must be: their .node binaries are loaded at runtime by
 * path and cannot be inlined. music-metadata is excluded because it resolves
 * parsers dynamically, which esbuild cannot follow statically. electron itself
 * is provided by the runtime. electron-builder ships node_modules alongside the
 * bundle, so every one of these still resolves at runtime.
 */
const external = [
  'electron',
  'better-sqlite3',
  '@coooookies/windows-smtc-monitor',
  'music-metadata',
  // Reads app-update.yml off disk relative to its own location and pulls in
  // optional transports; bundling it breaks both.
  'electron-updater',
];

/** @type {import('esbuild').BuildOptions} */
const common = {
  bundle: true,
  platform: 'node',
  // Electron 41 ships Node 22; targeting it avoids needless downleveling.
  target: 'node22',
  sourcemap: true,
  logLevel: 'info',
  external,
};

const mainCfg = {
  ...common,
  entryPoints: [path.join(root, 'electron/main.ts')],
  outfile: path.join(outDir, 'main.mjs'),
  format: 'esm',
  // Main process only. The renderer never receives the URL — it asks whether
  // reporting is on and posts through IPC.
  define: { __BUG_REPORT_WEBHOOK__: JSON.stringify(WEBHOOK) },
  /**
   * Give the ESM bundle a working `require`.
   *
   * Some dependencies are CommonJS (dotenv among them) and call `require('fs')`
   * at load time. In an ESM output esbuild replaces that with a shim that throws
   * "Dynamic require of ... is not supported" — unless a `require` is already in
   * scope, which the shim then defers to. This provides one, and it is also what
   * lets the external native addons resolve.
   */
  banner: {
    js: [
      "import { createRequire as __vybecordCreateRequire } from 'node:module';",
      'const require = __vybecordCreateRequire(import.meta.url);',
    ].join('\n'),
  },
};

/**
 * Preload stays CommonJS — the best-supported shape for a preload with
 * contextIsolation. The .cjs extension is load-bearing: package.json declares
 * "type": "module", so a .js file here would be parsed as ESM and its `module`
 * reference would throw before contextBridge ever ran.
 */
const preloadCfg = {
  ...common,
  entryPoints: [path.join(root, 'electron/preload.ts')],
  outfile: path.join(outDir, 'preload.cjs'),
  format: 'cjs',
};

/**
 * The media worker runs the WinRT addon off Electron's STA main thread.
 * CJS with a .cjs extension: package.json declares "type": "module", so a plain
 * .js here would be loaded as ESM and its require() calls would fail.
 */
const workerCfg = {
  ...common,
  entryPoints: [path.join(root, 'electron/media-worker.ts')],
  outfile: path.join(outDir, 'media-worker.cjs'),
  format: 'cjs',
};

/**
 * The LRCLIB dump worker keeps better-sqlite3's synchronous queries off the
 * main thread — the dump is routinely 100 GB+, and the search box issues one
 * query per keystroke. Same CJS reasoning as the media worker above.
 */
const lrclibWorkerCfg = {
  ...common,
  entryPoints: [path.join(root, 'electron/lrclib-worker.ts')],
  outfile: path.join(outDir, 'lrclib-worker.cjs'),
  format: 'cjs',
};

/**
 * The renderer, bundled to a single classic script.
 *
 * It has to be bundled: the window is loaded over file://, where Chromium
 * refuses ES module imports (every import is a cross-origin request to a null
 * origin). An IIFE bundle sidesteps that entirely. platform:'browser' because
 * this half runs in the renderer and must not pull in node built-ins.
 */
const rendererCfg = {
  entryPoints: [path.join(root, 'ui/src/main.js')],
  outfile: path.join(outDir, 'ui/app.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'chrome130',
  sourcemap: true,
  logLevel: 'info',
};

/** Copy the static renderer assets (the JS is bundled separately). */
function copyUi() {
  const src = path.join(root, 'ui');
  const dst = path.join(outDir, 'ui');
  for (const file of ['index.html', 'styles.css']) {
    fs.mkdirSync(dst, { recursive: true });
    fs.copyFileSync(path.join(src, file), path.join(dst, file));
  }
  console.log(`[ui] copied static assets → ${dst}`);
}

fs.mkdirSync(outDir, { recursive: true });

if (watch) {
  const ctxs = await Promise.all([mainCfg, preloadCfg, workerCfg, lrclibWorkerCfg, rendererCfg].map(c => esbuild.context(c)));
  await Promise.all(ctxs.map(c => c.watch()));
  copyUi();
  fs.watch(path.join(root, 'ui'), { recursive: true }, () => {
    try { copyUi(); } catch (e) { console.error(`[ui] copy failed: ${e.message}`); }
  });
  console.log('watching for changes...');
} else {
  await Promise.all([mainCfg, preloadCfg, workerCfg, lrclibWorkerCfg, rendererCfg].map(c => esbuild.build(c)));
  copyUi();
  console.log('build complete');
}
