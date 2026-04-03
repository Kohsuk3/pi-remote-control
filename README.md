# pi-remote-control

[日本語版 README はこちら](./README.ja.md)

A [Pi](https://github.com/mariozechner/pi) extension that lets you control Pi from your smartphone via Tailscale.

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

## Technical Details

- **Runtime**: Node.js standard modules only (no external npm packages)
- **Port range**: 8920+ with automatic increment on collision
- **Event buffer**: Last 100 events retained per session
- **Streaming throttle**: `message_update` events throttled to 200ms intervals

## License

MIT
