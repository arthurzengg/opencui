# OpenCUI

A minimal local VS Code AI extension powered by [opencode](https://github.com/anomalyco/opencode).

It is **decoupled** from opencode at runtime: this extension only talks to the
opencode HTTP server through `@opencode-ai/sdk`. opencode internals are never
imported.

## Features

1. **Chat panel** — sidebar webview with workspace context.
2. **Inline edit (`Cmd+K`)** — rewrite the selection with a natural-language
   instruction; preview as a diff before applying.
3. **Review changes** — inspect changed files and red/green diffs before continuing.
4. **Apply** — every code block in chat has an `Apply` button that opens a diff
   against the active file.

The extension manages an `opencode serve` subprocess for you and shuts it down
on deactivation.

## Requirements

- VS Code 1.94+
- `opencode` binary on `PATH` (or set `opencui.binaryPath`)
- Bun (only for development)

## Develop

```bash
cd opencui
bun install
bun run compile
```

Then open this folder in VS Code and press `F5` to launch an Extension
Development Host.

## Package

```bash
bun run package
npx @vscode/vsce package
```

Outputs `opencui-x.y.z.vsix`. Install with:

```bash
code --install-extension opencui-x.y.z.vsix
```

## Settings

| Setting | Default | Description |
|---|---|---|
| `opencui.binaryPath` | `opencode` | Path to opencode binary |
| `opencui.serverPort` | `0` | Server port (`0` = random) |
| `opencui.model` | `""` | Default model id (reserved) |

## Commands

| Command | Default keybinding |
|---|---|
| `OpenCUI: Focus Chat` | `Cmd+L` / `Ctrl+L` |
| `OpenCUI: Inline Edit` | `Cmd+K` / `Ctrl+K` (in editor) |
| `OpenCUI: New Chat` | — |
| `OpenCUI: Restart Backend` | — |
| `OpenCUI: Show Logs` | — |

## Architecture

```
VS Code (this extension)
   │  HTTP / SSE  via @opencode-ai/sdk
   ▼
opencode serve (managed subprocess)
   │
   ▼
Agent / Tools / Providers
```

The extension owns:
- Editor UI (webview, input box, diff preview)
- Editor context collection (active file, selection)

opencode owns:
- AI agent / tools / model providers / sessions
