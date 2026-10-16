# Story Lens Client

Electron desktop companion for the Story Lens extension. It exposes authenticated `GET /capabilities` and `POST /ExecutePrompt` on `127.0.0.1:43127` and runs installed Claude Code, Codex and Gemini CLI models. The extension uses it for explicit page summaries.

```bash
bun install
bun run dev
```

`make install` and `make dev` provide the same commands; run `make help` for build, test, and packaging targets.

Install and sign in to at least one provider CLI first. [Gemini CLI](https://geminicli.com/docs/get-started/installation/) is supported for text AI and wiki crawling; use a current version with `--acp`, then click **Refresh models**. Gemini uses its reported model list and `default` effort; images continue to use Codex. An explicit **Gemini CLI command or path** can be set in the companion settings. Keep the companion running (closing hides it in the tray by default), copy the pairing token into the extension's Desktop client panel, connect, choose a model/effort, and click Summarize on an HTTP(S) page. From this directory, use `bun run typecheck`, `bun test`, and `bun run build` to verify; `bun run pack` creates an unpacked app, `bun run dist:mac` macOS DMGs for Intel and Apple Silicon, `bun run dist:win` a Windows x64 NSIS installer on Windows, and `bun run dist:linux` Linux x64 AppImage and Debian packages on Linux. On macOS, `bun run smoke:browser` runs a manual Chrome summary test after building the extension and starting the client. `bun run smoke:launcher` verifies the novel-site logo circle, drag persistence, viewport clamping, and embedded popup placement without a running client. Both browser checks require a built Chrome extension and Playwright Chromium (`bunx playwright-core install chromium` if necessary).

Publishing a [GitHub release](https://github.com/Hussain7Abbas/storylens-client/releases) automatically builds and tests its tag on Windows, macOS, and Linux, then attaches all five installers and `SHA256SUMS` after every platform succeeds. The tag must be `v<package.json version>`. Branch pushes, pull requests, and manual workflow runs build the same packages as workflow artifacts without publishing them. Release reruns replace matching assets. Packages are unsigned; installation, pairing, and tray behavior still need native smoke checks.

See the umbrella project's [setup, protocol, privacy, and limits](https://github.com/Hussain7Abbas/storylens/blob/develop/docs/client.md) and [implementation tracker](https://github.com/Hussain7Abbas/storylens/blob/develop/plan/main.md).

## Website and legal information

[Website](https://storylens.iscoded.com) · [Privacy Policy](https://storylens.iscoded.com/en/privacy/) · [Terms](https://storylens.iscoded.com/en/terms/). The settings window opens these links in the system browser; all other external windows remain denied.

The settings UI supports System/Light/Dark appearance. **Keep in system tray** defaults to true: closing hides the window and keeps the service available; use the tray menu to reopen or quit. Disable and save to quit on window close. Tray-only changes do not restart local AI.
