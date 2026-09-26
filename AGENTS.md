# Desktop client instructions

This repository is the desktop client for Story Lens and has independent Bun dependencies. When checked out as a submodule of the umbrella project, also follow its root `AGENTS.md`. Runtime code must use Node/Electron APIs, not Bun APIs. See the [desktop guide](https://github.com/Hussain7Abbas/storylens/blob/develop/docs/client.md).

- `src/providers/` owns CLI discovery/execution. Pass prompts by stdin and never through a shell. Validate requested model/effort against the catalog. Preserve the located CLI's runtime directory on PATH for both catalog discovery and execution.
- `src/service.ts` owns command admission and limits; `src/server.ts` owns the loopback HTTP interface. Do not import Electron into these modules. Protocol 2 requires `responseLanguage` (`en` or `ar`) on every `ExecutePrompt` request.
- `src/desktop/` owns main, preload, and renderer. Keep Node integration off, context isolation and sandbox on, and preload IPC narrow.
- Keep credentials in private app settings. Never log pairing token, page HTML, prompts, or output.
- Run `bun run typecheck`, `bun test`, and `bun run build` (or the matching Makefile targets). When working in the umbrella checkout, root rules also require extension/backend typechecks. Keep this file and docs current.

The settings window links to website/privacy/terms. Only those exact HTTPS URLs may open through Electron shell.openExternal; retain the external URL allowlist and denied window creation.
