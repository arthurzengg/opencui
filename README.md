# OpenCode Panel

> A React chat sidebar for AI coding in VS Code, powered by
> [opencode](https://github.com/sst/opencode). Bring your own model
> (Anthropic / OpenAI / Gemini / local). Everything runs locally — nothing
> leaves your machine except the API call to your chosen provider.

<table>
<tr>
<td width="50%" align="center">
  <img src="media/screenshots/panel-overview.png" alt="Panel overview" width="340"><br>
  <sub><b>Chat panel</b></sub>
</td>
<td width="50%" align="center">
  <img src="media/screenshots/model-picker.png" alt="Model · Agent · Effort picker" width="340"><br>
  <sub><b>Model · Agent · Effort picker</b></sub>
</td>
</tr>
<tr>
<td align="center">
  <img src="media/screenshots/chat-history.png" alt="Chat history" width="340"><br>
  <sub><b>Per-workspace chat history</b></sub>
</td>
<td align="center">
  <img src="media/screenshots/slash-commands.png" alt="Slash-command picker" width="340"><br>
  <sub><b>Slash commands</b></sub>
</td>
</tr>
<tr>
<td align="center">
  <img src="media/screenshots/mcp-servers.png" alt="Manage MCP servers" width="340"><br>
  <sub><b>Manage MCP servers</b></sub>
</td>
<td align="center">
  <img src="media/screenshots/context-usage.png" alt="Context-window usage" width="340"><br>
  <sub><b>Context-window usage</b></sub>
</td>
</tr>
</table>

## Highlights

- **`@file` and `@chat` mentions** — fuzzy file picker with chip-styled tokens and recently-opened files boosted; `@chat` pulls a past conversation into the prompt as context.
- **Image, PDF, and text attachments** — paperclip or clipboard paste; images render as preview thumbnails, and about fifty code and plain-text extensions are accepted alongside images and PDFs.
- **Review Changes** card per file with `Keep` / `Undo` per row and for all, SCM-style status badges, and attribution when a subagent made the edit. Undo locates each hunk by its line anchor before touching the file.
- **Edit + regenerate** — click any past user message; the conversation rewinds via opencode's `session.revert`. A stopped reply offers Retry.
- **Model · Agent · Effort picker** — one in-panel popover: search models grouped by provider, fold providers you do not use, pick from recent models, set the effort / reasoning budget for models that expose variants (gpt-5.5, claude-opus, etc.), and switch opencode agents.
- **Slash commands** — `/compact`, `/init`, `/undo`, `/redo`, `/fork`, `/new`, `/share`, and your workspace's custom opencode commands, from a picker that opens on `/`.
- **MCP servers and AI providers** managed from the panel — `/mcp` adds local or remote servers and connects or authenticates them; `/provider` connects any provider opencode supports by API key or OAuth, and the model picker reflects the change on next open.
- **Chat history per workspace**, including sessions started from the opencode TUI or another client in the same project; opening one makes it a regular conversation with edit and rewind.
- **Context-window usage ring** in the composer — amber at 85%, red at 95%, hover for the token count against the model's limit.

## Setup

OpenCode Panel talks to a locally-running [opencode](https://opencode.ai) server. One-time prerequisite:

```bash
# Install opencode (pick one)
curl -fsSL https://opencode.ai/install | bash      # macOS / Linux
irm https://opencode.ai/install.ps1 | iex          # Windows
npm install -g opencode-ai                         # any platform
brew install sst/tap/opencode                      # macOS Homebrew

# Sign in to your provider (one time)
opencode auth login
```

Then install the extension:

```bash
code --install-extension haoyangzeng.opencui
```

Or search **"OpenCode Panel"** in the VS Code Extensions sidebar. Open the panel via the activity-bar icon or `Cmd+L` / `Ctrl+L`.

If `opencode` isn't on `PATH`, set `opencui.binaryPath` in settings to its absolute path.

## Settings

| Setting | Default | Description |
|---|---|---|
| `opencui.binaryPath` | `opencode` | Path to the opencode binary. |
| `opencui.serverPort` | `0` | Local opencode HTTP port (`0` = auto). |
| `opencui.model` | `""` | Default model (`providerID/modelID`). Change at runtime via the chat header. |

## Develop

```bash
bun install
bun run watch         # esbuild + vite single-file
```

Open the folder in VS Code and press `F5` to launch an Extension Development Host.

## License

MIT. See [LICENSE](./LICENSE).
