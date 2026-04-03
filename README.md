# pi-remote-control

[日本語版 README はこちら](./README.ja.md)

A [Pi](https://github.com/badlogic/pi-mono) extension that lets you control Pi from your smartphone via Tailscale.

Securely connect over HTTPS and interact with Pi through a mobile-optimized Web UI — send prompts, view LLM responses in real-time, switch models, and manage multiple sessions.

## Features

- 📱 **Send prompts from your phone** — chat with Pi via Web UI
- ⚡ **Real-time LLM streaming** — watch responses as they generate
- 🔄 **Model switching** — change models directly from Web UI
- 📁 **Session switching** — jump between multiple Pi sessions
- 🔒 **HTTPS** — TLS termination via `tailscale serve`, no port numbers needed
- 🖥️ **Dual input** — both host Pi and Web UI can send prompts, with shared history
- 🔢 **Multi-session** — automatic port assignment per session
- 📜 **Session history** — see past conversation when connecting mid-session
- ✅ **Confirmation dialogs** — respond to `ctx.ui.confirm()` from the Web UI or TUI, whichever comes first
- 🇯🇵 **iOS Japanese IME** — full flick input support with Safari bug workarounds

## Prerequisites

- [Tailscale](https://tailscale.com/) installed and connected
- Your smartphone on the same Tailscale network

## Installation

```bash
pi install git:github.com/Kohsuk3/pi-remote-control
```

## Usage

Start Pi and the remote control server launches automatically:

```
📱 Remote Control: ポート 8920
URL: https://your-machine.tail1234.ts.net/remote
Session: a1b2c3d4 | Dir: /path/to/project
/remote-toggle で切替え | /remote-status で詳細
```

Open the URL in your phone's browser. That's it.

The URL requires no port number — `tailscale serve` handles HTTPS on port 443 with path-based routing at `/remote`.

## Commands

| Command | Description |
|---------|-------------|
| `/remote-status` | Show connection status, port, and URL |
| `/remote-toggle` | Enable/disable remote control |

## Web UI

A mobile-optimized chat interface:

- Prompt input with send button
- Real-time LLM response streaming
- Tool execution status display
- Model picker (tap model name in header)
- Session switcher (tap session ID in header)
- Interrupt button for canceling in-progress responses
- **Confirmation dialogs** — Yes/No modal with countdown timer
- iOS Japanese flick input fully supported

## How It Works

### Communication

HTTP long-polling (no WebSocket dependency, works on all browsers):

- `GET /poll` — initial connection, returns session info + event history
- `GET /stream` — long-poll, waits up to 25s for new events
- `POST /send` — send a prompt to the Pi agent
- `POST /interrupt` — cancel in-progress processing
- `GET /models` — list available models
- `POST /set-model` — switch the active model
- `GET /sessions` — list all active remote-control sessions
- `POST /confirm/respond` — respond to a confirmation dialog (`{ confirmId, confirmed: boolean }`)

### Tailscale Integration

- **`tailscale serve`** proxies `https://hostname/remote` → `http://localhost:<port>`
- TLS termination is handled by Tailscale (no self-managed certificates)
- Clean, bookmarkable URL with no port number
- Path-based routing (`/remote`) avoids conflicts with other services

### Multi-Session

- Each Pi session gets an auto-assigned port (8920, 8921, ...)
- Session registry at `~/.pi/remote-control/sessions.json` enables cross-process discovery
- Dead processes are automatically cleaned up via PID checks
- Web UI session switcher redirects to other sessions' URLs

### iOS Safari Compatibility

Includes workarounds for known iOS Safari bugs:

- **Japanese IME `deleteCompositionText` bug** — Safari fires `deleteCompositionText` without a subsequent `insertText` when confirming composition with the 確定 button. The extension saves the pre-deletion value and restores it on `compositionend`.
- **Auto-resize during composition** — Modifying `textarea.style.height` during IME composition cancels the composition on iOS. Resize is skipped while `composing` flag is true.
- **Keyboard viewport** — Uses `visualViewport` API to resize layout when the software keyboard appears.

### Confirmation Dialogs

Extensions that call `ctx.ui.confirm()` (e.g. a file-delete guard) can expose the dialog to the Web UI:

1. The extension calls `(globalThis as any).__remoteConfirm(title, message, timeoutSec)` instead of (or alongside) `ctx.ui.confirm()`.
2. A `confirm:request` event is pushed to all connected Web UI clients.
3. The Web UI shows a modal with **Yes** and **No** buttons and a countdown timer.
4. The user taps a button → `POST /confirm/respond` → the Promise resolves and the extension continues.

When both the TUI and Web UI are active, whichever responds first wins. The other dialog is closed automatically (`AbortSignal` for TUI, `confirm:resolved` event for Web UI).

**Globals exposed by this extension (same Node.js process):**

| Global | Type | Description |
|--------|------|-------------|
| `__remoteConfirm` | `(title, message, timeoutSec) => Promise<boolean>` | Request a confirmation from Web UI |
| `__remoteCancelConfirm` | `(confirmed: boolean) => void` | Force-resolve the latest pending dialog (call when TUI responds first) |

## Technical Details

- **Runtime**: Node.js standard modules only (no external npm packages)
- **Port range**: 8920+ with automatic increment on collision
- **Event buffer**: Last 100 events retained per session
- **Streaming throttle**: `message_update` events throttled to 200ms intervals
- **Confirm timeout**: Default 120 s; auto-resolves as `false` (rejected) on expiry

## License

MIT
