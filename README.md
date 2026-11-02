# Respire for Obsidian

Respire brings AI coding agents into your vault and adds an optional local-first memory layer powered by [rsrs](https://github.com/risense-ai/respire-cli). Chat with Claude Code, Codex, OpenCode, Grok Build, Pi, or DeepSeek Harness without leaving Obsidian, and let rsrs recall relevant past context and keep session notes for later.

> **Unofficial fork.** Respire is an MIT-licensed fork of [Claudian](https://github.com/yishentu/claudian) by Yishen Tu, extended with Respire memory integration. It is not affiliated with or endorsed by the Claudian author.

## Features

- **Agent chat in the sidebar** — your vault is the working directory, so file reads, edits, search, bash, and multi-step workflows work out of the box.
- **Multiple providers** — Claude Code, Codex, DeepSeek Harness, Grok Build, OpenCode V2, and Pi.
- **Inline edit** — select text and rewrite it in place with a word-level diff preview.
- **Projects, tabs, Zen mode, slash commands, @mentions, MCP** — the full Claudian workflow.
- **Optional rsrs memory**
  - Recalls relevant memory entries before a turn and injects them into the prompt.
  - Stores a short diary entry after a turn when you opt into automatic memory.
  - Extracts memory from local agent sessions on demand (`rsrs extract`).
  - Redacts common credential patterns before content is sent to the memory store.

## Requirements

- Obsidian 1.13.0 or newer, desktop only (Windows, macOS, Linux).
- At least one provider CLI (for example [Claude Code](https://code.claude.com/docs/en/overview), [Codex](https://github.com/openai/codex), or [OpenCode V2](https://github.com/anomalyco/opencode)) plus a compatible subscription or API key.
- Optional: the `rsrs` CLI for memory features.

## Installation

### Community plugins

After the plugin is accepted into the Obsidian community directory:

1. Open **Settings → Community plugins → Browse**.
2. Search for **Respire** and install it.
3. Enable the plugin.

### Manual installation

1. Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/risense-ai/respire-obsidian/releases/latest).
2. Create `<vault>/.obsidian/plugins/respire/` and put the three files there.
3. Reload Obsidian and enable **Respire** under Community plugins.

### From source

```bash
git clone https://github.com/risense-ai/respire-obsidian.git
cd respire-obsidian
npm install
npm run build
```

Copy `main.js`, `manifest.json`, and `styles.css` into `<vault>/.obsidian/plugins/respire/`.

## rsrs memory setup

Memory is **disabled by default**. Respire never downloads or bundles the rsrs binary; it only calls an rsrs executable that you install and control.

1. Install the CLI:

   ```bash
   npm install -g rsrs-cli
   ```

2. Verify it is available:

   ```bash
   rsrs --version
   ```

3. In Obsidian, open **Settings → Respire → Rsrs memory**:
   - Turn on **Enable rsrs memory**.
   - If `rsrs` is not on `PATH`, set the absolute path in **Rsrs binary path**.
   - Use **Check** to confirm the CLI is found.
   - Enable **Remember completed turns** if you want diary entries written automatically.
   - Use **Extract sessions now** to import local agent sessions with `rsrs extract`.

Recall uses your configured project name plus the current prompt as the query. Automatic storage follows rsrs judge-then-store behavior: trivial turns are written as diary entries, while important turns attach to a same-topic parent when one exists and otherwise stay trivial. Nothing is force-written.

If the CLI is missing, Respire shows a notice at startup and in settings instead of failing silently.

## Privacy and data use

- **Provider traffic** — your prompts, attachments, and tool output go to the provider you select (Anthropic, OpenAI, xAI, OpenCode-configured providers, and so on). That traffic is governed by that provider's terms.
- **Memory traffic** — when memory is enabled, the prompt and reply for a turn are passed to the local `rsrs` CLI for recall and storage. rsrs keeps its data in a local encrypted store; any sync is performed by rsrs under your own configuration. The plugin does not send memory data to risense-ai servers.
- **Redaction** — common secret shapes (private-key blocks, bearer tokens, and several API-key formats) are scrubbed before text is sent to rsrs. Redaction is best-effort; do not paste secrets into chats.
- **No telemetry** — the plugin does not include analytics or telemetry beacons.
- **Local listener** — some providers use a loopback-only (`127.0.0.1`) listener for session tools.

## Development

```bash
npm run dev        # watch build
npm run build      # production build
npm run typecheck
npm run lint
npm run test
```

The plugin is desktop-only because it launches provider CLIs and manages local child processes.

## Troubleshooting

- **"Claude Code CLI not found"** — install the provider CLI and make sure it is on `PATH`, or configure its path in the provider settings.
- **rsrs not found** — install `rsrs-cli`, then use **Check** in the memory settings or set the binary path explicitly.
- **A model is missing** — open the provider tab in settings and run **Discover** after the CLI is authenticated.

For provider-specific notes, see the [troubleshooting guide](docs/troubleshooting.md). For bugs in Respire, open an issue in this repository. For issues in the upstream project, use the [Claudian issue tracker](https://github.com/yishentu/claudian/issues).

## Attribution

Respire is based on Claudian, Copyright (c) 2025 Yishen Tu, licensed under the MIT License. The original copyright and permission notice are retained in [LICENSE](LICENSE); see [NOTICE](NOTICE) for details.

Changes and the Respire memory integration are Copyright (c) 2026 risense-ai.

Obsidian, Claude, Claude Code, Codex, OpenCode, and other product names are trademarks of their respective owners.
