# Desktop client instructions

This repository is the desktop client for Story Lens and has independent Bun dependencies. When checked out as a submodule of the umbrella project, also follow its root `AGENTS.md`. Runtime code must use Node/Electron APIs, not Bun APIs. See the [desktop guide](https://github.com/Hussain7Abbas/storylens/blob/develop/docs/client.md).

- `src/providers/` owns CLI discovery/execution. Pass prompts by stdin and never through a shell. Validate requested model/effort against the catalog. Preserve the located CLI's runtime directory on PATH for both catalog discovery and execution.
- `src/service.ts` owns command admission and limits; `src/server.ts` owns the loopback HTTP interface. Do not import Electron into these modules. Protocol 2 requires `responseLanguage` (`en` or `ar`) on every `ExecutePrompt` request.
- `src/desktop/` owns main, preload, and renderer. Keep Node integration off, context isolation and sandbox on, and preload IPC narrow.
- Keep credentials in private app settings. Never log pairing token, page HTML, prompts, or output.
- Run `bun run typecheck`, `bun test`, and `bun run build` (or the matching Makefile targets). When working in the umbrella checkout, root rules also require extension/backend typechecks. Keep this file and docs current.

The settings window links to website/privacy/terms. Only those exact HTTPS URLs may open through Electron shell.openExternal; retain the external URL allowlist and denied window creation.

- Desktop visual identity follows Ink & Iris (`apps/website/design-system/MASTER.md` in the umbrella): light/dark tokens in `src/desktop/style.css`, self-hosted Inter and Lucide at 1.75 stroke. The build copies the font and approved Lensbook icon into `dist/desktop`. Packaging uses `build/icon.png` (1024px), `build/icon.icns` for macOS, and `build/icon.ico` for Windows. Shared source and regeneration instructions live in umbrella `docs/branding/`. System/Light/Dark appearance persists in renderer local storage. Button actions have tooltips, busy states and error feedback; status updates must preserve unsaved form edits.
- `keepInSystemTray` is a validated boolean in private settings, default true for new and legacy files. The narrow save IPC accepts it; tray-only changes must not restart the loopback service. Main owns the Tray, restricted Open/Quit menu, hide-on-close, restore on activation/second instance, and explicit quit guard. Disabled tray or tray creation failure uses quit-on-close. Do not introduce Electron imports into configuration/service/server. Test settings migration/persistence and window/tray lifecycle; Windows tray behavior still needs native Windows verification.
