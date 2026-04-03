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
- iOS日本語フリック入力完全対応

## 技術仕様

- **通信方式**: HTTP long-polling（WebSocket不要、全ブラウザ対応）
- **HTTPS**: `tailscale serve` によるTLS終端（証明書の自己管理不要）
- **ポート**: 8920から開始、衝突時は自動インクリメント
- **依存関係**: Node.js標準モジュールのみ（外部パッケージ不要）
- **イベントバッファ**: セッションごとに最新100件を保持
- **ストリーミング間引き**: `message_update` を200ms間隔に制限

## ライセンス

MIT
