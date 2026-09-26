# Story Lens Client

Electron desktop companion for the Story Lens extension. It exposes authenticated `GET /capabilities` and `POST /ExecutePrompt` on `127.0.0.1:43127` and runs installed Claude Code/Codex CLI models. The extension uses it for explicit page summaries.

```bash
bun install
bun run dev
```

`make install` and `make dev` provide the same commands; run `make help` for build, test, and packaging targets.

Sign in to at least one provider CLI first. Keep the window open, copy the pairing token into the extension's Desktop client panel, connect, choose a model/effort, and click Summarize on an HTTP(S) page. From this directory, use `bun run typecheck`, `bun test`, and `bun run build` to verify; `bun run pack` creates an unpacked app, `bun run dist:mac` a macOS DMG, and `bun run dist:win` a Windows NSIS installer on Windows. On macOS, `bun run smoke:browser` runs a manual Chrome summary test after building the extension and starting the client. `bun run smoke:launcher` verifies the novel-site logo circle, drag persistence, viewport clamping, and embedded popup placement without a running client. Both browser checks require a built Chrome extension and Playwright Chromium (`bunx playwright-core install chromium` if necessary).

See the umbrella project's [setup, protocol, privacy, and limits](https://github.com/Hussain7Abbas/storylens/blob/develop/docs/client.md) and [implementation tracker](https://github.com/Hussain7Abbas/storylens/blob/develop/plan/main.md).

## Website and legal information

[Website](https://storylens.iscoded.com) · [Privacy Policy](https://storylens.iscoded.com/en/privacy/) · [Terms](https://storylens.iscoded.com/en/terms/). The settings window opens these links in the system browser; all other external windows remain denied.
