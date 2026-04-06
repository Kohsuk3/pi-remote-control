# pi-remote-control

[English README](./README.md)

スマートフォンからPiをリモートコントロールする拡張機能。

Tailscale HTTPS経由でセキュアに接続し、モバイル最適化されたWeb UIからPiを操作できます。

## 機能

- 📱 **スマートフォンからプロンプト送信** — Web UIでPiと対話
- ⚡ **LLM応答のリアルタイム表示** — ストリーミング対応
- 🔄 **モデル切り替え** — Web UIからモデルを変更
- 📁 **セッション切り替え** — 複数のPiセッション間を移動
- 🔒 **HTTPS** — `tailscale serve` によるTLS終端、ポート番号不要
- 🖥️ **ホスト側Piも同時操作可能** — 双方向のやり取りを共有
- 🔢 **マルチセッション** — セッションごとにポート自動割り当て
- 📜 **履歴表示** — 途中参加でも過去のやり取りを表示
- ✅ **確認ダイアログ対応** — `ctx.ui.confirm()` をWEB UIまたはTUIのどちらからでも操作可能（先に応答した方を採用）
- 🚀 **セッション起動** — Web UIから最近のプロジェクト候補またはディレクトリブラウザで新Piセッションを起動
- 🗑️ **セッション終了** — サイドバーから他のセッションを終了（確認ダイアログ付き）
- 🇯🇵 **iOS日本語フリック入力対応** — Safariのバグ回避策を実装

## 前提条件

- [Tailscale](https://tailscale.com/) がインストール・接続済み
- スマートフォンも同じTailscaleネットワークに参加

## インストール

```bash
pi install git:github.com/Kohsuk3/pi-remote-control
```

## 使い方

Piを起動すると自動的にリモートコントロールサーバーが起動します:

```
📱 Remote Control: ポート 8920
URL: https://your-machine.tail1234.ts.net/remote
Session: a1b2c3d4 | Dir: /path/to/project
/remote-toggle で切替え | /remote-status で詳細
```

表示されたURLをスマートフォンのブラウザで開くだけです。

`tailscale serve` がHTTPS（443番ポート）でパスベースルーティングを行うため、ポート番号なしのURLでアクセスできます。

## コマンド

| コマンド | 説明 |
|----------|------|
| `/remote-status` | 接続状態・ポート・URLを表示 |
| `/remote-toggle` | リモートコントロールのオン/オフ切り替え |

## Web UI

モバイル最適化されたチャットインターフェース:

- プロンプト入力・送信
- LLM応答のリアルタイムストリーミング表示
- ツール実行状況の表示
- モデル選択（ヘッダーのモデル名をタップ）
- セッション切り替え（ヘッダーのセッションIDをタップ）
- 中断ボタン
- **確認ダイアログ** — Yes/Noモーダル（タイムアウトカウントダウン付き）
- **新規セッション起動** — 最近のプロジェクトからタップで起動、またはディレクトリブラウザで選択
- **セッション終了** — サイドバーの×ボタンで確認後に終了
- iOS日本語フリック入力完全対応

## 確認ダイアログの仕組み

`ctx.ui.confirm()` を使う拡張機能（例: ファイル削除ガード）をWEB UIと連携させる方法：

1. 拡張機能が `ctx.ui.confirm()` の代わりに `(globalThis as any).__remoteConfirm(title, message, timeoutSec)` を呼ぶ
2. `confirm:request` イベントが接続中のWEB UIクライアント全員に配信される
3. WEB UIにカウントダウン付きのYes/Noモーダルが表示される
4. ユーザーがタップ → `POST /confirm/respond` → Promiseが解決され拡張機能が処理を再開

TUIとWEB UIが両方アクティブな場合は**先に応答した方を採用**。もう一方は自動的に閉じる（TUI側は`AbortSignal`、WEB UI側は`confirm:resolved`イベント）。

**同一Node.jsプロセス内で公開されるグローバル関数:**

| グローバル | 型 | 説明 |
|---|---|---|
| `__remoteConfirm` | `(title, message, timeoutSec) => Promise<boolean>` | WEB UIに確認ダイアログを送信 |
| `__remoteCancelConfirm` | `(confirmed: boolean) => void` | 待機中のダイアログを強制解決（TUIが先に応答した時に呼ぶ） |

**エンドポイント（追加分）:**

| エンドポイント | 説明 |
|---|---|
| `POST /confirm/respond` | `{ confirmId, confirmed: boolean }` で確認ダイアログに応答 |
| `POST /spawn-session` | `{ cwd: string }` で新しいPiセッションを起動 |
| `GET /recent-dirs` | Piセッション履歴から最近のプロジェクトディレクトリ一覧 |
| `GET /browse?path=` | ディレクトリブラウザ（サブディレクトリ一覧） |
| `POST /kill-session` | `{ pid: number }` でセッションを終了 |

## 技術仕様

- **通信方式**: HTTP long-polling（WebSocket不要、全ブラウザ対応）
- **HTTPS**: `tailscale serve` によるTLS終端（証明書の自己管理不要）
- **ポート**: 8920から開始、衝突時は自動インクリメント
- **依存関係**: Node.js標準モジュールのみ（外部パッケージ不要）
- **イベントバッファ**: セッションごとに最新100件を保持
- **ストリーミング間引き**: `message_update` を200ms間隔に制限
- **確認タイムアウト**: デフォルト120秒、期限切れは自動拒否（false）

## ライセンス

MIT
