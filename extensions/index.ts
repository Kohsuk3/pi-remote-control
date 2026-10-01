/**
 * remote-control/index.ts — Piリモートコントロール拡張機能
 *
 * Tailscale経由でスマートフォンからPiをリモートコントロールする。
 * HTTPS + HTTP long-polling方式。
 *
 * 機能:
 *   - セッション起動時に自動でHTTPSサーバー起動（Tailscale証明書）
 *   - スマートフォン用Web UIを提供
 *   - Web UI / ホスト双方からのプロンプト入力・LLM応答のリアルタイム表示
 *   - セッションごとのポート自動割り当て（複数セッション対応）
 *   - ツール実行状況の表示
 *   - ctx.ui.confirm() 対応 — Web UI で確認ダイアログの Yes/No を操作可能
 *
 * コマンド:
 *   /remote-status  接続状態とポート情報を表示
 *   /remote-toggle  リモートコントロールのオン/オフ切り替え
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import http from "node:http";
import net from "node:net";
import crypto from "node:crypto";
import path from "node:path";
import fsSync from "node:fs";
import { execSync, execFile, spawn, type ChildProcess } from "node:child_process";
import os from "node:os";

type Evt = { id: number; type: string; [k: string]: unknown };

interface WaitingClient {
  resolve: (events: Evt[]) => void;
  timer: ReturnType<typeof setTimeout>;
}

interface ServerInstance {
  httpServer: http.Server;
  port: number;
  url: string;
  workingDir: string;
  sessionId: string;
  eventLog: Evt[];
  waitingClients: Map<string, WaitingClient>;
  nextEventId: number;
}

interface PendingConfirm {
  id: string;
  title: string;
  message: string;
  resolve: (confirmed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingConfirms = new Map<string, PendingConfirm>();

function requestWebConfirm(title: string, message: string, timeoutSeconds: number = 60): Promise<boolean> {
  const id = `confirm_${crypto.randomUUID().slice(0, 8)}`;
  return new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => {
      pendingConfirms.delete(id);
      resolve(false); // タイムアウトは拒否扱い
    }, timeoutSeconds * 1000);
    pendingConfirms.set(id, { id, title, message, resolve, timer });
    // 全アクティブセッションに確認リクエストを配信
    for (const [_, s] of sessionServers) {
      pushEvent(s.sessionId, {
        type: "confirm:request",
        confirmId: id,
        title,
        message,
        timeoutSeconds,
      });
    }
  });
}

function respondWebConfirm(confirmId: string, confirmed: boolean): void {
  const pending = pendingConfirms.get(confirmId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingConfirms.delete(confirmId);
    pending.resolve(confirmed);
    // eventLog に「解決済み」を追記 → リロード時にダイアログが再表示されないようにする
    for (const [_, s] of sessionServers) {
      pushEvent(s.sessionId, { type: "confirm:resolved", confirmId, confirmed });
    }
  }
}

/**
 * TUI側が先に応答した場合にWEB UIに「既に解決済み」を通知する。
 * confirmId を省略すると最新の pending を対象にする。
 */
function cancelWebConfirm(confirmed: boolean, confirmId?: string): void {
  const id = confirmId ?? [...pendingConfirms.keys()].at(-1);
  if (!id) return;
  const pending = pendingConfirms.get(id);
  if (!pending) return;
  clearTimeout(pending.timer);
  pendingConfirms.delete(id);
  pending.resolve(confirmed);
  // WEB UI にも「解決済み」イベントを配信してダイアログを閉じる
  for (const [_, s] of sessionServers) {
    pushEvent(s.sessionId, { type: "confirm:resolved", confirmId: id, confirmed });
  }
}

const occupiedPorts = new Set<number>();
const sessionServers = new Map<string, ServerInstance>();

interface SpawnedSession {
  proc: ChildProcess;
  cwd: string;
  startedAt: number;
}

const spawnedSessions = new Map<number, SpawnedSession>(); // pid → info

/** 指定 cwd で pi --mode rpc を子プロセスとして起動
 *  親プロセスが死んでも子が生き残るように:
 *  - detached: true で独立プロセスグループ
 *  - tail -f /dev/null 経由で stdin を永続化（親の pipe が壊れても EOF にならない）
 */
function spawnPiSession(cwd: string): { pid: number } {
  const piPath = findPiBinary();

  // nohup sh -c 'tail -f /dev/null | pi --mode rpc' で起動
  // nohup: SIGHUP を無視して親終了時も生き残る
  // tail -f /dev/null: stdin を開き続ける（親の pipe が壊れても EOF にならない）
  // stdout/stderr を /dev/null にして pipe 依存を完全に断つ
  const child = spawn("sh", ["-c", `trap '' HUP; tail -f /dev/null | exec ${piPath} --mode rpc > /dev/null 2>&1`], {
    cwd,
    stdio: ["ignore", "ignore", "ignore"],
    detached: true,
    env: { ...process.env },
  });

  child.unref();

  if (!child.pid) {
    throw new Error("子プロセスの起動に失敗しました");
  }

  const pid = child.pid;
  spawnedSessions.set(pid, { proc: child, cwd, startedAt: Date.now() });

  child.on("exit", () => {
    spawnedSessions.delete(pid);
  });



  return { pid };
}

function findPiBinary(): string {
  try {
    return execSync("which pi", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "pi";
  }
}

/** sessions.json にスポーンしたセッションが登録されるのを待つ
 *  sh 経由で起動するため PID が変わるので、起動前のレジストリとの差分で検出 */
async function waitForSpawnedSession(knownPids: Set<number>, paneId?: string, timeoutMs: number = 20000): Promise<RegistryEntry | null> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    await new Promise(r => setTimeout(r, 500));
    const entries = readRegistry();
    const newEntry = paneId
      ? entries.find(e => e.paneId === paneId && !knownPids.has(e.pid))
      : entries.find(e => !knownPids.has(e.pid));
    if (newEntry) return newEntry;
  }
  return null;
}

function expandTilde(p: string): string {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p;
}

/** Pi セッション履歴からプロジェクトディレクトリ一覧を取得 */
function getRecentProjectDirs(): string[] {
  const sessionsDir = path.join(os.homedir(), ".pi", "agent", "sessions");
  const dirs = new Set<string>();
  try {
    const subdirs = fsSync.readdirSync(sessionsDir, { withFileTypes: true })
      .filter(d => d.isDirectory())
      .map(d => d.name);
    for (const subdir of subdirs) {
      const files = fsSync.readdirSync(path.join(sessionsDir, subdir))
        .filter(f => f.endsWith(".jsonl"))
        .sort()
        .reverse();
      if (files.length === 0) continue;
      // 最新セッションファイルの1行目から cwd を取得
      try {
        const firstLine = fsSync.readFileSync(
          path.join(sessionsDir, subdir, files[0]), "utf-8"
        ).split("\n")[0];
        const header = JSON.parse(firstLine);
        if (header.cwd && typeof header.cwd === "string") {
          if (fsSync.existsSync(header.cwd)) {
            dirs.add(header.cwd);
          }
        }
      } catch {}
    }
  } catch {}
  return [...dirs].sort();
}

function listSubdirectories(dirPath: string): { name: string; path: string }[] {
  try {
    const resolved = path.resolve(expandTilde(dirPath));
    return fsSync.readdirSync(resolved, { withFileTypes: true })
      .filter(d => d.isDirectory() && !d.name.startsWith("."))
      .sort((a, b) => a.name.localeCompare(b.name))
      .map(d => ({ name: d.name, path: path.join(resolved, d.name) }));
  } catch {
    return [];
  }
}

function cleanupSpawnedSessions(): void {
  for (const [pid, s] of spawnedSessions) {
    killSpawnedSession(pid);
  }
  spawnedSessions.clear();
}

/** 指定 PID のセッションを終了する。成功時 true、見つからない or 失敗時 false */
function killSpawnedSession(pid: number): boolean {
  const s = spawnedSessions.get(pid);
  if (s) {
    try {
      // sh + tail + pi のプロセスツリーごと終了（負の PID でプロセスグループに SIGTERM）
      process.kill(-pid, "SIGTERM");
    } catch {
      try { process.kill(pid, "SIGTERM"); } catch {}
    }
    spawnedSessions.delete(pid);
    return true;
  }
  // スポーンした子ではないが、レジストリ上の他プロセスを SIGTERM で終了
  try {
    process.kill(pid, "SIGTERM");
    return true;
  } catch {
    return false;
  }
}

const REGISTRY_PATH = path.join(os.homedir(), ".pi", "remote-control", "sessions.json");

interface RegistryEntry {
  sessionId: string;
  port: number;
  url: string;
  directUrl: string; // Tailscale IP + ポートの直接URL（セッション切り替え用）
  workingDir: string;
  pid: number;
  paneId?: string; // HERDR_PANE_ID
  lastPrompt?: string; // サイドバーで何のセッションか分かるように
  sessionFile?: string; // herdr の agent_session と突き合わせる
}

function readRegistry(): RegistryEntry[] {
  try {
    const data = JSON.parse(fsSync.readFileSync(REGISTRY_PATH, "utf-8"));
    return (data as RegistryEntry[]).filter(e => {
      try { process.kill(e.pid, 0); return true; } catch { return false; }
    });
  } catch { return []; }
}

function writeRegistry(entries: RegistryEntry[]): void {
  try {
    fsSync.mkdirSync(path.dirname(REGISTRY_PATH), { recursive: true });
    fsSync.writeFileSync(REGISTRY_PATH, JSON.stringify(entries, null, 2));
  } catch {}
}

function registerSession(entry: RegistryEntry): void {
  const entries = readRegistry().filter(e => e.sessionId !== entry.sessionId);
  entries.push(entry);
  writeRegistry(entries);
}

function patchRegistry(sessionId: string, patch: Partial<RegistryEntry>): void {
  const entries = readRegistry();
  const e = entries.find(x => x.sessionId === sessionId);
  if (!e) return;
  Object.assign(e, patch);
  writeRegistry(entries);
}

function unregisterSession(sessionId: string): void {
  writeRegistry(readRegistry().filter(e => e.sessionId !== sessionId));
}

// ---- herdr 連携 ------------------------------------------------------------
// herdr 配下で動いているとき、セッションの実体は herdr のペイン。
// 一覧の表示名/状態は herdr から取り、起動/終了もペイン操作で行う（headless rpc は見えない子になるため）。

const HERDR_BIN = process.env.HERDR_BIN_PATH || "herdr";
const HERDR_ON = process.env.HERDR_ENV === "1";

function herdrJson(args: string[]): Promise<any | null> {
  return new Promise((resolve) => {
    execFile(HERDR_BIN, args, { timeout: 4000, encoding: "utf-8" }, (err, out) => {
      if (err) return resolve(null);
      try { resolve(JSON.parse(out).result ?? null); } catch { resolve(null); }
    });
  });
}

interface HerdrPane {
  paneId: string;
  workspaceId: string;
  workspace: string;
  status: string; // idle | working | blocked | unknown
  cwd: string;
  sessionFile?: string;
}

let herdrCache: { at: number; panes: HerdrPane[] } = { at: 0, panes: [] };

async function herdrSnapshot(maxAgeMs = 2000): Promise<HerdrPane[]> {
  if (!HERDR_ON) return [];
  if (Date.now() - herdrCache.at < maxAgeMs) return herdrCache.panes;
  const [panes, wss] = await Promise.all([herdrJson(["pane", "list"]), herdrJson(["workspace", "list"])]);
  if (!panes?.panes) return herdrCache.panes; // 失敗時は古い値で凌ぐ
  const labels = new Map<string, string>((wss?.workspaces ?? []).map((w: any) => [w.workspace_id, w.label]));
  herdrCache = {
    at: Date.now(),
    panes: panes.panes.map((p: any): HerdrPane => ({
      paneId: p.pane_id,
      workspaceId: p.workspace_id,
      workspace: labels.get(p.workspace_id) ?? p.workspace_id,
      status: p.agent_status ?? "unknown",
      cwd: p.cwd ?? "",
      sessionFile: p.agent_session?.kind === "path" ? p.agent_session.value : undefined,
    })),
  };
  return herdrCache.panes;
}

function matchPane(panes: HerdrPane[], e: RegistryEntry): HerdrPane | undefined {
  return (e.sessionFile && panes.find(p => p.sessionFile === e.sessionFile))
    || (e.paneId ? panes.find(p => p.paneId === e.paneId) : undefined);
}

interface SessionView extends RegistryEntry {
  workspace?: string;
  status: string;
  paneKnown: boolean;
}

/** レジストリ + herdr の状態。blocked → working → idle → unknown の順、同順位は workspace 名 */
async function listSessionViews(): Promise<SessionView[]> {
  const panes = await herdrSnapshot();
  const rank: Record<string, number> = { blocked: 0, working: 1, idle: 2, unknown: 3 };
  return readRegistry()
    .map((e): SessionView => {
      const p = matchPane(panes, e);
      return { ...e, workspace: p?.workspace, status: p?.status ?? "unknown", paneKnown: !!p };
    })
    .sort((a, b) =>
      (rank[a.status] ?? 3) - (rank[b.status] ?? 3)
      || (a.workspace ?? a.workingDir).localeCompare(b.workspace ?? b.workingDir)
      || a.port - b.port);
}

/** herdr のタブ（無ければワークスペース）を作って pi を走らせる。成功時はペイン ID */
async function spawnInHerdr(cwd: string): Promise<string | null> {
  const panes = await herdrSnapshot(0);
  const sameDir = panes.find(p => p.cwd === cwd);
  const label = path.basename(cwd) || cwd;
  const created = sameDir
    ? await herdrJson(["tab", "create", "--workspace", sameDir.workspaceId, "--cwd", cwd, "--label", label])
    : await herdrJson(["workspace", "create", "--cwd", cwd, "--label", label, "--no-focus"]);
  const paneId: string | undefined = created?.root_pane?.pane_id;
  if (!paneId) return null;
  const run = await herdrJson(["pane", "run", paneId, findPiBinary()]);
  return run ? paneId : null;
}

function extractText(message: any): string {
  if (!message?.content) return "";
  return message.content
    .filter((c: any) => c.type === "text" && c.text)
    .map((c: any) => c.text)
    .join("")
    .trim();
}

/** イベントを追加し、long-poll 待機中のクライアントに即座に配信 */
function pushEvent(sessionId: string, event: Omit<Evt, "id">): void {
  const s = sessionServers.get(sessionId);
  if (!s) return;

  const evt: Evt = { ...event, id: s.nextEventId++ };
  s.eventLog.push(evt);
  if (s.eventLog.length > 100) s.eventLog.splice(0, s.eventLog.length - 100);

  for (const [cid, wc] of s.waitingClients) {
    clearTimeout(wc.timer);
    wc.resolve([evt]);
    s.waitingClients.delete(cid);
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => resolve(body));
  });
}

/** Tailscale の FQDN を取得（HTTPS 証明書用） */
function getTailscaleFQDN(): string {
  try {
    const json = execSync("tailscale status --self --json 2>/dev/null", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const dns: string = JSON.parse(json)?.Self?.DNSName || "";
    return dns.replace(/\.$/, "");
  } catch {
    return "";
  }
}

function getTailscaleIP(): string {
  try {
    return execSync("tailscale ip -4 2>/dev/null", {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim() || "localhost";
  } catch {
    return "localhost";
  }
}

const SERVE_PATH = "/remote";

const HUB_PATH = path.join(os.homedir(), ".pi", "remote-control", "hub.json");
let hubTimer: ReturnType<typeof setInterval> | null = null;

function pidAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

function readHub(): { pid: number; port: number } | null {
  try { return JSON.parse(fsSync.readFileSync(HUB_PATH, "utf-8")); } catch { return null; }
}

/** tailscale serve でパスベースのプロキシを設定（TLS終端はtailscaleが担当） */
function setupTailscaleServe(port: number): boolean {
  try {
    execSync(
      `tailscale serve --bg --set-path ${SERVE_PATH} http://localhost:${port}`,
      { stdio: "ignore" },
    );
    return true;
  } catch {
    return false;
  }
}

function teardownTailscaleServe(): void {
  try {
    execSync(`tailscale serve --set-path ${SERVE_PATH} off`, { stdio: "ignore" });
  } catch {}
}

/**
 * 共有 URL (tailscale serve の /remote) の持ち主を 1 プロセスに固定する。
 * 以前は「最後に起動したセッションが奪う / どれかが終了すると serve を消す」ため、
 * セッションが多いと URL が頻繁に死んでいた。持ち主が死んだら生きている誰かが 5 秒以内に引き継ぐ。
 * ponytail: hub.json の書き込み競合は後勝ち。厳密な排他が要るなら lockfile。
 */
function ensureHub(ownPort: number): void {
  const hub = readHub();
  if (hub && hub.pid !== process.pid && pidAlive(hub.pid)) return;
  if (hub?.pid === process.pid && hub.port === ownPort) {
    // 古いバージョンのセッションが終了時に serve を消すことがある → 持ち主が実在確認して張り直す
    try {
      const st = execSync("tailscale serve status 2>&1", { encoding: "utf-8", stdio: ["ignore", "pipe", "ignore"] });
      if (!st.includes(SERVE_PATH)) setupTailscaleServe(ownPort);
    } catch {}
    return;
  }
  if (!getTailscaleFQDN()) return;
  if (setupTailscaleServe(ownPort)) {
    fsSync.mkdirSync(path.dirname(HUB_PATH), { recursive: true });
    fsSync.writeFileSync(HUB_PATH, JSON.stringify({ pid: process.pid, port: ownPort }));
  }
}

function startHubWatcher(ownPort: number): void {
  ensureHub(ownPort);
  if (hubTimer) clearInterval(hubTimer);
  hubTimer = setInterval(() => ensureHub(ownPort), 5000);
  hubTimer.unref?.();
}

/** 終了時: 持ち主だったなら hub.json を消す。他に生存セッションがいなければ serve も外す */
function releaseHub(): void {
  if (hubTimer) { clearInterval(hubTimer); hubTimer = null; }
  if (readHub()?.pid === process.pid) {
    try { fsSync.unlinkSync(HUB_PATH); } catch {}
  }
  if (readRegistry().length === 0) teardownTailscaleServe();
}

/** リモートアクセス URL を生成 */
function buildRemoteUrl(port: number, fqdn: string, useTailscaleServe: boolean): string {
  if (useTailscaleServe && fqdn) {
    return `https://${fqdn}${SERVE_PATH}`;
  }
  return `http://${getTailscaleIP()}:${port}`;
}

async function findAvailablePort(start: number): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const candidate = start + i;
    if (occupiedPorts.has(candidate)) continue;
    try {
      await new Promise<void>((resolve, reject) => {
        const srv = net.createServer();
        srv.on("error", reject);
        srv.listen(candidate, "0.0.0.0", () => srv.close(() => resolve()));
      });
      return candidate;
    } catch {}
  }
  throw new Error(`ポート ${start}〜 が全て使用中です`);
}

function generateHTML(): string {
  return `<!DOCTYPE html>
<html lang="ja">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="theme-color" content="#0f0f23">
<title>Pi Remote</title>
<style>
:root{--bg:#0f0f23;--sf:#1a1a2e;--tx:#e0e0ff;--dm:#8888aa;--ac:#7c3aed;--ok:#10b981;--er:#ef4444;--bd:#333355;--fn:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;--fm:'SF Mono',Monaco,monospace}
*{box-sizing:border-box;margin:0;padding:0}
html{position:fixed;width:100%;height:100%;overflow:hidden}
body{font-family:var(--fn);background:var(--bg);color:var(--tx);height:100dvh;display:flex;flex-direction:column;overflow:hidden;position:fixed;width:100%;touch-action:none;overscroll-behavior:none}
.hd{flex-shrink:0;background:var(--sf);padding:12px 16px;padding-top:max(12px,env(safe-area-inset-top));border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:10px}
.dot{width:10px;height:10px;border-radius:50%;background:var(--er);flex-shrink:0;transition:.3s}
.dot.ok{background:var(--ok)}.dot.wait{background:#f59e0b;animation:pulse 1.5s infinite}.dot.work{background:var(--ac);animation:pulse .8s infinite}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:.4}}
.ht{font-weight:600;font-size:16px;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hm{font-size:12px;color:var(--dm)}
.chat{flex:1;min-height:0;overflow-y:auto;padding:16px;display:flex;flex-direction:column;gap:12px;-webkit-overflow-scrolling:touch;touch-action:pan-y;overscroll-behavior:contain}
.m{max-width:100%;padding:12px 14px;border-radius:16px;line-height:1.5;word-break:break-word;animation:fadeIn .2s ease-out}
@keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1}}
.m.s{font-size:13px;color:var(--dm);background:var(--sf);text-align:center}
.m.u{background:var(--ac);color:#fff;align-self:flex-end;border-bottom-right-radius:4px;white-space:pre-wrap}
.m.a{background:#2d2d4a;align-self:flex-start;border-bottom-left-radius:4px;white-space:pre-wrap;-webkit-user-select:text;user-select:text}
.m.t{background:var(--sf);border-left:3px solid #f59e0b;font-family:var(--fm);font-size:.85em;padding:10px 14px}
.ia{flex-shrink:0;background:var(--sf);padding:12px 16px;padding-bottom:max(12px,env(safe-area-inset-bottom));border-top:1px solid var(--bd);display:flex;gap:10px;align-items:flex-end}
#inp{flex:1;min-height:40px;max-height:120px;padding:10px 14px;border-radius:20px;border:1px solid var(--bd);background:var(--bg);color:var(--tx);font-size:16px;font-family:var(--fn);resize:none;outline:none}
#inp:focus{border-color:var(--ac)}
#inp::placeholder{color:var(--dm)}
.b{width:40px;height:40px;border-radius:50%;border:none;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.b:active{transform:scale(.9)}
.b.snd{background:var(--ac);color:#fff}
.b.stp{background:var(--er);color:#fff;display:none}
.b.stp.on{display:flex}
.b.snd.off{display:none}
pre,code{background:var(--bg);padding:4px 8px;border-radius:6px;font-family:var(--fm);font-size:.9em;overflow-x:auto;-webkit-user-select:text;user-select:text}
#mdl{font-size:11px;color:var(--dm);cursor:pointer;padding:4px 8px;border-radius:8px;background:var(--bg);border:1px solid var(--bd);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:140px;flex-shrink:0}
#mdl:active{background:var(--bd)}
.overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.7);z-index:100;align-items:flex-end;justify-content:center}
.overlay.show{display:flex}
.modal{background:var(--sf);border-radius:16px 16px 0 0;width:100%;max-height:70vh;display:flex;flex-direction:column;padding-bottom:env(safe-area-inset-bottom,12px)}
.modal-title{padding:16px;font-weight:600;font-size:15px;border-bottom:1px solid var(--bd);text-align:center}
.modal-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch}
.modal-item{padding:14px 16px;border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:10px;cursor:pointer;font-size:14px}
.modal-item:active{background:var(--bg)}
.modal-item.active{color:var(--ac)}
.modal-item .mi-check{width:20px;flex-shrink:0;text-align:center}
.modal-item .mi-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.modal-item .mi-prov{font-size:11px;color:var(--dm);flex-shrink:0}
.confirm-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:200;align-items:center;justify-content:center;padding:20px}
.confirm-overlay.show{display:flex}
.confirm-modal{background:var(--sf);border:1px solid var(--bd);border-radius:16px;width:100%;max-width:480px;box-shadow:0 16px 48px rgba(0,0,0,.5);animation:confirmIn .2s ease-out}
@keyframes confirmIn{from{opacity:0;transform:scale(.95)}to{opacity:1;transform:scale(1)}}
.confirm-header{padding:16px 16px 12px;border-bottom:1px solid var(--bd)}
.confirm-header h3{font-size:16px;color:var(--er);margin:0;white-space:pre-wrap;word-break:break-word}
.confirm-body{padding:16px;font-size:14px;line-height:1.6;max-height:40vh;overflow-y:auto;-webkit-user-select:text;user-select:text;white-space:pre-wrap;word-break:break-word;font-family:var(--fm)}
.confirm-footer{padding:12px 16px 20px;border-top:1px solid var(--bd);display:flex;gap:12px;justify-content:flex-end}
.confirm-footer button{padding:10px 24px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--fn);transition:opacity .15s}
.confirm-footer button:active{transform:scale(.96)}
.btn-no{background:var(--bd);color:var(--tx)}
.btn-no:hover{opacity:.85}
.btn-yes{background:var(--er);color:#fff}
.btn-yes:hover{opacity:.85}
.confirm-timer{padding:0 16px 8px;font-size:12px;color:var(--dm);text-align:center}

#hamburger{position:relative;width:36px;height:36px;border-radius:8px;border:none;background:transparent;cursor:pointer;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:5px;padding:0;flex-shrink:0;-webkit-tap-highlight-color:transparent}
#hamburger span{display:block;width:20px;height:2px;background:var(--tx);border-radius:2px;transition:transform .3s ease,opacity .3s ease,top .3s ease}
#hamburger:active{background:var(--bd)}
#hamburger.open span:nth-child(1){transform:translateY(7px) rotate(45deg)}
#hamburger.open span:nth-child(2){opacity:0;transform:scaleX(0)}
#hamburger.open span:nth-child(3){transform:translateY(-7px) rotate(-45deg)}

#hamburger.attn::after{content:'';position:absolute;top:3px;right:3px;width:9px;height:9px;border-radius:50%;background:#f59e0b;animation:pulse 1s infinite}
.st{width:10px;height:10px;border-radius:50%;background:#555;flex-shrink:0}
.st.idle{background:var(--ok)}.st.working{background:var(--ac);animation:pulse .8s infinite}.st.blocked{background:#f59e0b;animation:pulse 1s infinite}
.sb-filter{margin:8px 12px 0;padding:10px 12px;border-radius:10px;border:1px solid var(--bd);background:var(--bg);color:var(--tx);font-size:16px;font-family:var(--fn);outline:none;display:none}
.sb-filter:focus{border-color:var(--ac)}
.sb-backdrop{display:none;position:fixed;inset:0;background:rgba(0,0,0,.5);z-index:50;backdrop-filter:blur(2px);-webkit-backdrop-filter:blur(2px);transition:opacity .3s}
.sb-backdrop.open{display:block;animation:bdIn .25s ease forwards}
@keyframes bdIn{from{opacity:0}to{opacity:1}}

.sidebar{position:fixed;top:0;left:0;bottom:0;width:min(280px,85vw);background:var(--sf);border-right:1px solid var(--bd);z-index:60;display:flex;flex-direction:column;transform:translateX(-100%);transition:transform .3s cubic-bezier(.4,0,.2,1);box-shadow:none;padding-top:env(safe-area-inset-top,0px)}
.sidebar.open{transform:translateX(0);box-shadow:4px 0 32px rgba(0,0,0,.4)}
.sb-header{padding:20px 16px 14px;font-size:11px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:var(--dm);border-bottom:1px solid var(--bd);flex-shrink:0}
.sb-list{flex:1;overflow-y:auto;-webkit-overflow-scrolling:touch;padding:8px 0}

.sb-item{display:flex;align-items:center;gap:12px;padding:12px 16px;cursor:pointer;border-radius:10px;margin:2px 8px;transition:background .15s;-webkit-tap-highlight-color:transparent}
.sb-item:active{background:var(--bg)}
.sb-item.active{background:rgba(124,58,237,.12)}
.sb-item-icon{font-size:20px;flex-shrink:0;width:32px;text-align:center}
.sb-item-body{flex:1;min-width:0}
.sb-item-name{font-size:13px;font-weight:600;color:var(--tx);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;margin-bottom:2px}
.sb-item-prompt{font-size:12px;color:var(--tx);opacity:.8;margin-bottom:2px;display:-webkit-box;-webkit-line-clamp:2;-webkit-box-orient:vertical;overflow:hidden;line-height:1.35}
.sb-item-sub{font-size:11px;color:var(--dm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-family:var(--fm)}
.sb-cur-dot{width:8px;height:8px;border-radius:50%;background:var(--ok);flex-shrink:0;box-shadow:0 0 6px var(--ok)}
.sb-item-badge{font-size:10px;font-weight:600;color:var(--ac);background:rgba(124,58,237,.15);padding:3px 8px;border-radius:20px;border:1px solid rgba(124,58,237,.3);flex-shrink:0;white-space:nowrap}
.sb-item-badge.blocked{color:#f59e0b;background:rgba(245,158,11,.15);border-color:rgba(245,158,11,.4)}
.sb-item-close{width:28px;height:28px;border-radius:50%;border:none;background:transparent;color:var(--dm);font-size:16px;cursor:pointer;display:flex;align-items:center;justify-content:center;flex-shrink:0;-webkit-tap-highlight-color:transparent;transition:background .15s,color .15s}
.sb-item-close:active{background:rgba(239,68,68,.15);color:var(--er)}

.sb-new-btn{display:flex;align-items:center;gap:10px;padding:14px 16px;cursor:pointer;border-radius:10px;margin:8px 8px 2px;border:1px dashed var(--bd);color:var(--ac);font-size:13px;font-weight:600;transition:background .15s}
.sb-new-btn:active{background:rgba(124,58,237,.1)}
.sb-new-icon{font-size:20px;width:32px;text-align:center;flex-shrink:0}
.spawn-overlay{display:none;position:fixed;inset:0;background:rgba(0,0,0,.75);z-index:200;align-items:center;justify-content:center;padding:20px}
.spawn-overlay.show{display:flex}
.spawn-modal{background:var(--sf);border:1px solid var(--bd);border-radius:16px;width:100%;max-width:480px;box-shadow:0 16px 48px rgba(0,0,0,.5);animation:confirmIn .2s ease-out}
.spawn-header{padding:16px 16px 12px;border-bottom:1px solid var(--bd)}
.spawn-header h3{font-size:16px;color:var(--ac);margin:0}
.spawn-body{padding:0;max-height:55vh;overflow-y:auto;-webkit-overflow-scrolling:touch}
.spawn-path-bar{display:flex;align-items:center;gap:4px;padding:10px 16px;background:var(--bg);border-bottom:1px solid var(--bd);font-family:var(--fm);font-size:12px;color:var(--dm);flex-wrap:wrap;position:sticky;top:0;z-index:1}
.spawn-path-bar .sp-seg{color:var(--ac);cursor:pointer;padding:2px 4px;border-radius:4px}
.spawn-path-bar .sp-seg:active{background:rgba(124,58,237,.15)}
.spawn-path-bar .sp-sep{color:var(--bd);flex-shrink:0}
.spawn-section{padding:8px 0}
.spawn-section-title{font-size:11px;font-weight:700;letter-spacing:.06em;text-transform:uppercase;color:var(--dm);padding:6px 16px 4px}
.spawn-dir-item{display:flex;align-items:center;gap:10px;padding:10px 16px;cursor:pointer;font-size:13px;color:var(--tx);transition:background .1s}
.spawn-dir-item:active{background:var(--bg)}
.spawn-dir-item .sdi-icon{font-size:16px;flex-shrink:0;width:24px;text-align:center}
.spawn-dir-item .sdi-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spawn-dir-item .sdi-arrow{color:var(--dm);font-size:14px;flex-shrink:0}
.spawn-dir-item .sdi-action{font-size:10px;font-weight:600;color:var(--ok);background:rgba(16,185,129,.12);padding:3px 8px;border-radius:12px;border:1px solid rgba(16,185,129,.25);flex-shrink:0;white-space:nowrap}
.spawn-dir-item.recent .sdi-icon{font-size:14px}
.spawn-empty{padding:20px 16px;text-align:center;font-size:13px;color:var(--dm)}
.spawn-error{font-size:12px;color:var(--er);padding:8px 16px;display:none}
.spawn-footer{padding:12px 16px 20px;border-top:1px solid var(--bd);display:flex;gap:12px;justify-content:flex-end;align-items:center}
.spawn-footer button{padding:10px 24px;border-radius:10px;border:none;font-size:14px;font-weight:600;cursor:pointer;font-family:var(--fn);transition:opacity .15s}
.spawn-footer button:active{transform:scale(.96)}
.spawn-footer .btn-cancel{background:var(--bd);color:var(--tx)}
.spawn-footer .btn-spawn{background:var(--ac);color:#fff}
.spawn-footer .btn-spawn:disabled{opacity:.5;cursor:not-allowed}
.spawn-footer .sf-path{flex:1;font-size:11px;color:var(--dm);font-family:var(--fm);overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.spawn-loading{display:none;padding:20px 16px;text-align:center;color:var(--dm);font-size:13px}
.spawn-tabs{display:flex;border-bottom:1px solid var(--bd);position:sticky;top:0;z-index:2;background:var(--sf)}
.spawn-tab{flex:1;padding:10px;text-align:center;font-size:12px;font-weight:600;color:var(--dm);cursor:pointer;border-bottom:2px solid transparent;transition:color .15s,border-color .15s}
.spawn-tab.active{color:var(--ac);border-bottom-color:var(--ac)}
.spawn-tab:active{background:var(--bg)}
</style>
</head>
<body>

<!-- サイドバー -->
<div id="sbBackdrop" class="sb-backdrop" onclick="closeSidebar()"></div>
<nav id="sidebar" class="sidebar">
  <div class="sb-header">Sessions</div>
  <input id="sbFilter" class="sb-filter" type="search" placeholder="絞り込み (workspace / dir / id)" oninput="renderSidebar()">
  <div id="sbList" class="sb-list"></div>
  <div class="sb-new-btn" onclick="openSpawnDialog()">
    <div class="sb-new-icon">➕</div>
    <div>New Session</div>
  </div>
</nav>

<!-- 新規セッション起動ダイアログ -->
<div id="spawnOverlay" class="spawn-overlay" onclick="closeSpawnDialog()">
  <div class="spawn-modal" onclick="event.stopPropagation()">
    <div class="spawn-header"><h3>🚀 新規セッション</h3></div>
    <div class="spawn-tabs">
      <div id="tabRecent" class="spawn-tab active" onclick="switchSpawnTab('recent')">Recent</div>
      <div id="tabBrowse" class="spawn-tab" onclick="switchSpawnTab('browse')">Browse</div>
    </div>
    <div id="spawnForm" class="spawn-body">
      <div id="spawnRecent" class="spawn-section"></div>
      <div id="spawnBrowse" class="spawn-section" style="display:none">
        <div id="spawnPathBar" class="spawn-path-bar"></div>
        <div id="spawnDirList"></div>
      </div>
      <div id="spawnError" class="spawn-error"></div>
    </div>
    <div id="spawnLoading" class="spawn-loading">⚙️ セッションを起動中...</div>
    <div class="spawn-footer">
      <div id="spawnSelPath" class="sf-path"></div>
      <button class="btn-cancel" onclick="closeSpawnDialog()">Cancel</button>
      <button id="spawnBtn" class="btn-spawn" disabled onclick="doSpawnSession()">Start</button>
    </div>
  </div>
</div>

<div class="hd">
  <button id="hamburger" onclick="toggleSidebar()" aria-label="メニュー">
    <span></span><span></span><span></span>
  </button>
  <div id="dot" class="dot"></div>
  <div class="ht" id="hdTitle">Pi Remote</div>
  <div id="mdl" onclick="openModelPicker()">---</div>
  <div id="hm" class="hm"></div>
</div>

<div id="modelOverlay" class="overlay" onclick="closeModelPicker()">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-title">モデル選択</div>
    <div id="modelList" class="modal-list"></div>
  </div>
</div>

<div id="msgs" class="chat"></div>

<!-- 確認ダイアログ -->
<div id="confirmOverlay" class="confirm-overlay" onclick="closeConfirm()">
  <div class="confirm-modal" onclick="event.stopPropagation()">
    <div class="confirm-header"><h3 id="confirmTitle"></h3></div>
    <div class="confirm-body" id="confirmBody"></div>
    <div class="confirm-timer" id="confirmTimer"></div>
    <div class="confirm-footer">
      <button class="btn-no" onclick="respondConfirm(false)">No</button>
      <button class="btn-yes" onclick="respondConfirm(true)">Yes</button>
    </div>
  </div>
</div>

<div class="ia">
  <textarea id="inp" placeholder="プロンプトを入力…" rows="1"></textarea>
  <button id="snd" class="b snd"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg></button>
  <button id="stp" class="b stp"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><rect x="4" y="4" width="16" height="16" rx="2"/></svg></button>
</div>

<script>
const $=s=>document.getElementById(s);
const ROOT=(()=>{let p=location.pathname;const i=p.indexOf('/s/');if(i>=0)p=p.slice(0,i);while(p.endsWith('/'))p=p.slice(0,-1);return p;})();
let target=(()=>{const p=location.pathname,i=p.indexOf('/s/');if(i<0)return '';const r=p.slice(i+3),j=r.indexOf('/');return j<0?r:r.slice(0,j);})();
let epoch=0;
function api(path){return ROOT+(target?'/s/'+target:'')+path;}
const msgs=$("msgs"), inp=$("inp"), dot=$("dot"), hm=$("hm"), sndBtn=$("snd"), stpBtn=$("stp");
let lastId=0, processing=false, streamEl=null, sentLocally=false;
let currentConfirmId=null, confirmTimerEl=null;
let currentSessionId='';

function toggleSidebar(){
  const sb=$('sidebar'), bd=$('sbBackdrop'), hb=$('hamburger');
  const opening=!sb.classList.contains('open');
  sb.classList.toggle('open',opening);
  bd.classList.toggle('open',opening);
  hb.classList.toggle('open',opening);
  if(opening) refreshSessions();
}
function closeSidebar(){
  $('sidebar').classList.remove('open');
  $('sbBackdrop').classList.remove('open');
  $('hamburger').classList.remove('open');
}
function dirTail(w,n){return (w||'').split('/').filter(Boolean).slice(-n).join('/');}
let sessionsCache=[];
async function refreshSessions(){
  try{
    const r=await fetch(ROOT+'/sessions');
    if(!r.ok) throw 0;
    sessionsCache=(await r.json()).sessions||[];
    const cur=sessionsCache.find(x=>x.sessionId===target||(!target&&x.sessionId===currentSessionId));
    if(cur){ $('hdTitle').textContent=cur.workspace||dirTail(cur.workingDir,1); }
    $('hamburger').classList.toggle('attn',sessionsCache.some(x=>x.status==='blocked'&&x.sessionId!==currentSessionId));
    renderSidebar();
  }catch(e){
    if($('sidebar').classList.contains('open')) $('sbList').innerHTML='<div style="padding:20px;color:var(--er);font-size:13px;text-align:center">読み込み失敗</div>';
  }
}
function renderSidebar(){
  const list=$('sbList'), f=$('sbFilter');
  f.style.display=sessionsCache.length>5?'block':'none';
  const q=f.value.trim().toLowerCase();
  const shown=sessionsCache.filter(s=>!q||((s.workspace||'')+' '+s.workingDir+' '+s.sessionId+' '+(s.lastPrompt||'')).toLowerCase().includes(q));
  list.innerHTML='';
  if(!shown.length){
    list.innerHTML='<div style="padding:20px;color:var(--dm);font-size:13px;text-align:center">セッションなし</div>';
    return;
  }
  for(const s of shown){
    const isCur=s.sessionId===currentSessionId;
    const dir=dirTail(s.workingDir,2);
    const item=document.createElement('div');
    item.className='sb-item'+(isCur?' active':'');
    item.innerHTML=
      '<div class="sb-item-icon"><span class="st '+esc(s.status||'')+'" style="display:inline-block"></span></div>'+
      '<div class="sb-item-body">'+
        '<div class="sb-item-name">'+esc(s.workspace||dir)+'</div>'+
        (s.lastPrompt?'<div class="sb-item-prompt">'+esc(s.lastPrompt)+'</div>':'')+
        '<div class="sb-item-sub">'+esc(s.workspace?dir+' · ':'')+s.sessionId+'</div>'+
      '</div>'+
      (s.status==='blocked'?'<div class="sb-item-badge blocked">要対応</div>':isCur?'<div class="sb-cur-dot"></div>':'');
    item.onclick=()=>{ closeSidebar(); if(!isCur) switchSession(s.sessionId); };
    if(!isCur){
      const closeBtn=document.createElement('button');
      closeBtn.className='sb-item-close';
      closeBtn.textContent='×';
      closeBtn.title='セッションを終了';
      closeBtn.onclick=(e)=>{ e.stopPropagation(); confirmKillSession(s.sessionId, s.pid, s.workspace||dir); };
      item.appendChild(closeBtn);
    }
    list.appendChild(item);
  }
}
function resetUi(){
  epoch++; lastId=0; streamEl=null; sentLocally=false; processing=false;
  msgs.innerHTML='';
  if(confirmTimerEl){ clearInterval(confirmTimerEl); confirmTimerEl=null; }
  currentConfirmId=null;
  $('confirmOverlay').classList.remove('show');
  sndBtn.classList.remove('off'); stpBtn.classList.remove('on'); inp.disabled=false;
  dot.className='dot';
}
function switchSession(id){
  target=id;
  resetUi();
  try{ history.replaceState(null,'',ROOT+'/s/'+id+'/'); }catch(e){}
  init();
}

function confirmKillSession(sessionId, pid, dirName){
  if(!confirm('セッションを終了しますか？\\n'+dirName+' ('+sessionId+')')) return;
  killSession(pid);
}
async function killSession(pid){
  try{
    const r=await fetch(api('/kill-session'),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({pid}),
    });
    const d=await r.json();
    if(d.ok){
      addM('s','🗑️ セッション終了 (pid='+pid+')');
      // プロセス終了の反映を待ってサイドバーを更新
      setTimeout(refreshSessions, 1500);
    } else {
      addM('s','❌ 終了失敗: '+(d.error||''));
    }
  }catch(e){
    addM('s','❌ 通信エラー');
  }
}

let spawnSelectedCwd='';
let spawnCurrentTab='recent';

function openSpawnDialog(){
  closeSidebar();
  spawnSelectedCwd='';
  $('spawnSelPath').textContent='';
  $('spawnBtn').disabled=true;
  $('spawnError').style.display='none';
  $('spawnForm').style.display='';
  $('spawnLoading').style.display='none';
  $('spawnOverlay').classList.add('show');
  switchSpawnTab('recent');
}
function closeSpawnDialog(){
  $('spawnOverlay').classList.remove('show');
}
function switchSpawnTab(tab){
  spawnCurrentTab=tab;
  $('tabRecent').classList.toggle('active',tab==='recent');
  $('tabBrowse').classList.toggle('active',tab==='browse');
  $('spawnRecent').style.display=tab==='recent'?'':'none';
  $('spawnBrowse').style.display=tab==='browse'?'':'none';
  if(tab==='recent') loadRecentDirs();
  if(tab==='browse') browseTo(spawnSelectedCwd||'~');
}
function selectCwd(p){
  spawnSelectedCwd=p;
  $('spawnSelPath').textContent=p;
  $('spawnBtn').disabled=false;
}

async function loadRecentDirs(){
  const el=$('spawnRecent');
  el.innerHTML='<div class="spawn-empty">読み込み中...</div>';
  try{
    const r=await fetch(api('/recent-dirs'));
    const d=await r.json();
    const dirs=d.dirs||[];
    if(!dirs.length){
      el.innerHTML='<div class="spawn-empty">最近のプロジェクトがありません</div>';
      return;
    }
    el.innerHTML='<div class="spawn-section-title">Recent Projects</div>';
    for(const dir of dirs){
      const name=dir.split('/').filter(Boolean).slice(-2).join('/');
      const item=document.createElement('div');
      item.className='spawn-dir-item recent';
      item.innerHTML='<div class="sdi-icon">📂</div><div class="sdi-name">'+esc(name)+'</div><div class="sdi-action">Start</div>';
      item.title=dir;
      item.onclick=()=>{ selectCwd(dir); doSpawnSession(); };
      el.appendChild(item);
    }
  }catch(e){
    el.innerHTML='<div class="spawn-empty">読み込み失敗</div>';
  }
}

async function browseTo(dirPath){
  const list=$('spawnDirList');
  list.innerHTML='<div class="spawn-empty">読み込み中...</div>';
  try{
    const r=await fetch(api('/browse?path='+encodeURIComponent(dirPath)));
    const d=await r.json();
    renderPathBar(d.current);
    selectCwd(d.current);
    list.innerHTML='';
    if(d.parent){
      const up=document.createElement('div');
      up.className='spawn-dir-item';
      up.innerHTML='<div class="sdi-icon">⬆️</div><div class="sdi-name">..</div>';
      up.onclick=()=>browseTo(d.parent);
      list.appendChild(up);
    }
    if(!d.entries||!d.entries.length){
      if(!d.parent) list.innerHTML='<div class="spawn-empty">サブディレクトリなし</div>';
      else { const empty=document.createElement('div'); empty.className='spawn-empty'; empty.textContent='サブディレクトリなし'; list.appendChild(empty); }
      return;
    }
    for(const e of d.entries){
      const item=document.createElement('div');
      item.className='spawn-dir-item';
      item.innerHTML='<div class="sdi-icon">📁</div><div class="sdi-name">'+esc(e.name)+'</div><div class="sdi-arrow">›</div>';
      item.onclick=()=>browseTo(e.path);
      list.appendChild(item);
    }
  }catch(e){
    list.innerHTML='<div class="spawn-empty">読み込み失敗</div>';
  }
}

function renderPathBar(fullPath){
  const bar=$('spawnPathBar');
  bar.innerHTML='';
  const parts=fullPath.split('/').filter(Boolean);
  let accumulated='/';
  const root=document.createElement('span');
  root.className='sp-seg';
  root.textContent='/';
  root.onclick=()=>browseTo('/');
  bar.appendChild(root);
  for(let i=0;i<parts.length;i++){
    accumulated+=(i>0?'/':'')+parts[i];
    const sep=document.createElement('span');
    sep.className='sp-sep';
    sep.textContent='/';
    bar.appendChild(sep);
    const seg=document.createElement('span');
    seg.className='sp-seg';
    seg.textContent=parts[i];
    const target=accumulated;
    seg.onclick=()=>browseTo(target);
    bar.appendChild(seg);
  }
}

function esc(s){return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');}

async function doSpawnSession(){
  const cwd=spawnSelectedCwd;
  if(!cwd) return;
  $('spawnBtn').disabled=true;
  $('spawnError').style.display='none';
  $('spawnForm').style.display='none';
  $('spawnLoading').style.display='block';
  try{
    const r=await fetch(api('/spawn-session'),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({cwd}),
    });
    const d=await r.json();
    if(d.ok && d.session){
      addM('s','🚀 新セッション起動: '+d.session.sessionId);
      closeSpawnDialog();
      switchSession(d.session.sessionId);
    } else {
      $('spawnForm').style.display='';
      $('spawnLoading').style.display='none';
      $('spawnBtn').disabled=!spawnSelectedCwd;
      $('spawnError').textContent=d.error||'起動に失敗しました';
      $('spawnError').style.display='block';
    }
  }catch(e){
    $('spawnForm').style.display='';
    $('spawnLoading').style.display='none';
    $('spawnBtn').disabled=!spawnSelectedCwd;
    $('spawnError').textContent='通信エラー';
    $('spawnError').style.display='block';
  }
}

function addM(cls,text){
  const d=document.createElement("div");
  d.className="m "+cls;
  d.textContent=text;
  msgs.appendChild(d);
  msgs.scrollTop=msgs.scrollHeight;
}

function setProcessing(v){
  processing=v;
  if(v){
    dot.className="dot work";
    sndBtn.classList.add("off");
    stpBtn.classList.add("on");
    inp.disabled=true;
  } else {
    dot.className="dot ok";
    sndBtn.classList.remove("off");
    stpBtn.classList.remove("on");
    inp.disabled=false;
    inp.focus();
  }
}

function showConfirm(confirmId, title, message, timeoutSec) {
  currentConfirmId = confirmId;
  $("confirmTitle").textContent = title;
  $("confirmBody").textContent = message;
  $("confirmOverlay").classList.add("show");
  if (timeoutSec > 0) {
    let remaining = timeoutSec;
    $("confirmTimer").textContent = remaining + "秒後に自動拒否";
    confirmTimerEl = setInterval(() => {
      remaining--;
      if (remaining <= 0) {
        clearInterval(confirmTimerEl);
        $("confirmTimer").textContent = "";
      } else {
        $("confirmTimer").textContent = remaining + "秒後に自動拒否";
      }
    }, 1000);
  } else {
    $("confirmTimer").textContent = "";
  }
}

function closeConfirm() {
  if (!currentConfirmId) return;
  const id = currentConfirmId;
  currentConfirmId = null;
  if (confirmTimerEl) clearInterval(confirmTimerEl);
  confirmTimerEl = null;
  $("confirmOverlay").classList.remove("show");
  // キャンセル = 拒否
  respondToServer(id, false);
}

function respondConfirm(confirmed) {
  if (!currentConfirmId) return;
  const id = currentConfirmId;
  currentConfirmId = null;
  if (confirmTimerEl) clearInterval(confirmTimerEl);
  confirmTimerEl = null;
  $("confirmOverlay").classList.remove("show");
  respondToServer(id, confirmed);
}

async function respondToServer(confirmId, confirmed) {
  try {
    await fetch(api("/confirm/respond"), {
      method: "POST",
      headers: {"Content-Type": "application/json"},
      body: JSON.stringify({ confirmId, confirmed }),
    });
  } catch(e) { console.error("Confirm response failed:", e); }
}

function handleEvents(events){
  for(const ev of events){
    if(ev.id!==undefined && ev.id>lastId) lastId=ev.id;
    switch(ev.type){
      case "agent:processing":
        setProcessing(true);
        streamEl=null;
        break;
      case "user:message":
        if(sentLocally){ sentLocally=false; }
        else { addM("u",ev.text||""); }
        break;
      case "confirm:request":
        showConfirm(ev.confirmId, ev.title||"確認", ev.message||"", ev.timeoutSeconds||60);
        break;
      case "confirm:resolved":
        // TUI側が先に応答 → モーダルを閉じる（応答は送らない）
        if (currentConfirmId === ev.confirmId) {
          currentConfirmId = null;
          if (confirmTimerEl) clearInterval(confirmTimerEl);
          confirmTimerEl = null;
          $("confirmOverlay").classList.remove("show");
          addM("s", ev.confirmed ? "✅ ホストで承認済み" : "🚫 ホストで拒否済み");
        }
        break;
      case "response:update":
        if(!streamEl){
          streamEl=document.createElement("div");
          streamEl.className="m a";
          msgs.appendChild(streamEl);
        }
        streamEl.textContent=(ev.text||"").trim();
        msgs.scrollTop=msgs.scrollHeight;
        break;
      case "response:done":
        if(!streamEl){
          streamEl=document.createElement("div");
          streamEl.className="m a";
          msgs.appendChild(streamEl);
        }
        streamEl.textContent=(ev.text||"").trim();
        streamEl=null;
        msgs.scrollTop=msgs.scrollHeight;
        break;
      case "agent:complete":
        setProcessing(false);
        streamEl=null;
        break;
      case "tool:result":
        addM("t","⚙️ "+ev.toolName+(ev.toolInput?" "+String(ev.toolInput).slice(0,80):""));
        break;
      case "agent:interrupted":
        setProcessing(false);
        streamEl=null;
        addM("s","⛔ 中断");
        break;
      case "model:changed":
        currentModelId=(ev.provider||"")+"/"+(ev.modelId||"");
        mdlBtn.textContent=String(ev.modelId||"").split("/").pop();
        mdlBtn.title=currentModelId;
        addM("s","🔄 モデル: "+currentModelId);
        break;
      case "server:shutdown":
        dot.className="dot";
        addM("s","サーバー終了");
        break;
    }
  }
}

async function init(){
  const ep=epoch;
  try{
    const r=await fetch(api("/poll?since=0"));
    if(!r.ok) throw 0;
    const d=await r.json();
    if(ep!==epoch) return;
    if(d.sessionId){
      dot.className="dot ok";
      updateSessionLabel(d.sessionId);
      hm.textContent=":"+d.port;
      addM("s","🔗 接続完了 ("+d.sessionId+")");
      handleEvents(d.events||[]);
      fetchModels();
      refreshSessions();
      streamLoop();
    }
  }catch(e){
    if(ep!==epoch) return;
    dot.className="dot wait";
    setTimeout(init,2000);
  }
}

async function streamLoop(){
  const ep=epoch;
  let fails=0;
  while(ep===epoch){
    try{
      const r=await fetch(api("/stream?since="+lastId));
      if(!r.ok) throw 0;
      const d=await r.json();
      if(ep!==epoch) return;
      fails=0;
      dot.className=processing?"dot work":"dot ok";
      handleEvents(d.events||[]);
    }catch(e){
      if(ep!==epoch) return;
      dot.className="dot wait";
      if(++fails===5){ addM("s","⚠️ セッションに接続できません。サイドバーから別のセッションを選べます"); refreshSessions(); }
      await new Promise(r=>setTimeout(r,2000));
    }
  }
}

setInterval(refreshSessions,5000);

async function send(){
  const t=inp.value.trim();
  if(!t)return;
  sentLocally=true;
  addM("u",t);
  inp.value="";
  inp.style.height="auto";
  setProcessing(true);
  try{
    await fetch(api("/send"),{
      method:"POST",
      headers:{"Content-Type":"application/json"},
      body:JSON.stringify({content:t}),
    });
  } catch(e){
    addM("s","送信失敗");
    setProcessing(false);
  }
}

async function interrupt(){
  try{ await fetch(api("/interrupt"),{method:"POST"}); } catch(e){}
  setProcessing(false);
  addM("s","⛔ 中断要求送信");
}

sndBtn.onclick=send;
stpBtn.onclick=interrupt;

function updateSessionLabel(sid){
  currentSessionId=sid;
  $('hdTitle').textContent='Pi · '+sid;
}

const mdlBtn=$('mdl'), modelOverlay=$('modelOverlay'), modelList=$('modelList');
let currentModelId='', models=[];

async function fetchModels(){
  try{
    const r=await fetch(api('/models'));
    const d=await r.json();
    models=d.models||[];
    currentModelId=d.current||'';
    mdlBtn.textContent=currentModelId.split('/').pop()||'---';
    mdlBtn.title=currentModelId;
  }catch(e){}
}

function openModelPicker(){
  fetchModels().then(()=>{
    modelList.innerHTML='';
    for(const m of models){
      const item=document.createElement('div');
      item.className='modal-item'+(m.id===currentModelId?' active':'');
      const fullId=m.provider+'/'+m.id;
      item.innerHTML=
        '<span class="mi-check">'+(fullId===currentModelId?'✓':'')+
        '</span><span class="mi-name">'+m.id+
        '</span><span class="mi-prov">'+m.provider+'</span>';
      item.onclick=()=>selectModel(m.provider,m.id);
      modelList.appendChild(item);
    }
    modelOverlay.classList.add('show');
  });
}

function closeModelPicker(){ modelOverlay.classList.remove('show'); }

async function selectModel(provider,id){
  closeModelPicker();
  mdlBtn.textContent='...';
  try{
    const r=await fetch(api('/set-model'),{
      method:'POST',
      headers:{'Content-Type':'application/json'},
      body:JSON.stringify({provider,id}),
    });
    const d=await r.json();
    if(d.ok){
      currentModelId=provider+'/'+id;
      mdlBtn.textContent=id.split('/').pop();
      mdlBtn.title=currentModelId;
      addM('s','🔄 モデル切替: '+currentModelId);
    } else {
      addM('s','❌ 切替失敗: '+(d.error||''));
      fetchModels();
    }
  }catch(e){
    addM('s','❌ モデル切替エラー');
    fetchModels();
  }
}

// iOS Safari バグ対策
let composing=false, savedBeforeDelete=null;

inp.addEventListener("compositionstart",()=>{ composing=true; savedBeforeDelete=null; });
inp.addEventListener("beforeinput",e=>{
  if(e.inputType==="deleteCompositionText"){ savedBeforeDelete=inp.value; }
  else if(e.inputType==="insertText"||e.inputType==="insertFromComposition"){ savedBeforeDelete=null; }
});
inp.addEventListener("compositionend",()=>{
  composing=false;
  if(savedBeforeDelete!==null){ inp.value=savedBeforeDelete; }
  savedBeforeDelete=null;
});

inp.addEventListener("keydown",e=>{
  if(e.key==="Enter"&&!e.shiftKey&&!processing&&!composing&&!e.isComposing){
    e.preventDefault(); send();
  }
});

inp.addEventListener("input",()=>{
  if(composing) return;
  inp.style.height="auto";
  inp.style.height=Math.min(120,inp.scrollHeight)+"px";
});

if(window.visualViewport){
  const vv=window.visualViewport;
  function fitToViewport(){ document.body.style.height=vv.height+'px'; window.scrollTo(0,0); }
  vv.addEventListener('resize',fitToViewport);
  vv.addEventListener('scroll',()=>window.scrollTo(0,0));
  fitToViewport();
}

init();
</script>
</body>
</html>`;
}

async function startServer(
  sessionId: string,
  workingDir: string,
  ctx: ExtensionContext,
  piApi: ExtensionAPI,
): Promise<{ port: number; url: string }> {
  const port = await findAvailablePort(8920);
  const html = generateHTML();

  const fqdn = getTailscaleFQDN();
  const useTailscaleServe = !!fqdn;
  const url = buildRemoteUrl(port, fqdn, useTailscaleServe);

  const httpServer = http.createServer();

  const instance: ServerInstance = {
    httpServer,
    port,
    url,
    workingDir,
    sessionId,
    eventLog: [],
    waitingClients: new Map(),
    nextEventId: 1,
  };
  sessionServers.set(sessionId, instance);
  occupiedPorts.add(port);

  // 過去のやり取りをイベントログに積む（途中参加のWeb UIに表示するため）
  let lastPrompt: string | undefined;
  try {
    const history = ctx.sessionManager.buildSessionContext();
    for (const msg of history.messages) {
      const text = extractText(msg);
      if (!text) continue;
      if (msg.role === "user") {
        lastPrompt = text.replace(/\s+/g, " ").slice(0, 120);
        pushEvent(sessionId, { type: "user:message", text });
      } else if (msg.role === "assistant") {
        pushEvent(sessionId, { type: "response:done", text });
      }
    }
  } catch {}

  httpServer.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    let pathname = reqUrl.pathname;

    // /s/<sessionId>/... → そのセッションへ中継。共有 HTTPS URL 1 本で全セッションを切り替えられる
    // (以前は http://<tailscale-ip>:<port> へページ遷移していた)
    if (pathname.startsWith("/s/")) {
      const rest = pathname.slice(3);
      const slash = rest.indexOf("/");
      const targetId = slash < 0 ? rest : rest.slice(0, slash);
      pathname = slash < 0 ? "/" : rest.slice(slash);
      if (targetId !== sessionId) {
        const target = readRegistry().find(e => e.sessionId === targetId);
        if (!target) {
          res.writeHead(404, { "Content-Type": "application/json" });
          res.end('{"error":"session not found"}');
          return;
        }
        const upstream = http.request(
          { host: "127.0.0.1", port: target.port, method: req.method, path: pathname + reqUrl.search, headers: { ...req.headers, host: `127.0.0.1:${target.port}` } },
          (ur) => { res.writeHead(ur.statusCode || 502, ur.headers); ur.pipe(res); },
        );
        upstream.on("error", () => {
          if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
          res.end('{"error":"upstream unavailable"}');
        });
        res.on("close", () => upstream.destroy());
        req.pipe(upstream);
        return;
      }
    }

    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
    res.setHeader("Access-Control-Allow-Headers", "Content-Type");
    if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

    // 初回接続: セッション情報 + 未読イベント
    if (pathname === "/poll") {
      const since = parseInt(reqUrl.searchParams.get("since") || "0", 10);
      const events = instance.eventLog.filter(e => e.id > since);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessionId, port, workingDir, events }));
      return;
    }

    // Long-poll: イベント到着まで最大 25 秒待機
    if (pathname === "/stream") {
      const since = parseInt(reqUrl.searchParams.get("since") || "0", 10);
      const pending = instance.eventLog.filter(e => e.id > since);
      if (pending.length > 0) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ events: pending }));
        return;
      }
      const cid = crypto.randomUUID();
      const timer = setTimeout(() => {
        instance.waitingClients.delete(cid);
        if (!res.writableEnded) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ events: [] }));
        }
      }, 25000);
      instance.waitingClients.set(cid, {
        resolve: (events) => {
          if (!res.writableEnded) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ events }));
          }
        },
        timer,
      });
      req.on("close", () => { clearTimeout(timer); instance.waitingClients.delete(cid); });
      return;
    }

    // プロンプト受信 → Pi エージェントに送信
    if (req.method === "POST" && pathname === "/send") {
      const body = await readBody(req);
      try {
        const text = String(JSON.parse(body).content || "").trim();
        if (text) {
          ctx.ui.notify(`📱 プロンプト受信: ${text.slice(0, 80)}`, "info");
          piApi.sendUserMessage(text);
        }
      } catch {}
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    // 確認レスポンス受信 → 待機中の confirm を解決
    if (req.method === "POST" && pathname === "/confirm/respond") {
      const body = await readBody(req);
      try {
        const { confirmId, confirmed } = JSON.parse(body);
        if (confirmId !== undefined && typeof confirmed === "boolean") {
          respondWebConfirm(confirmId, confirmed);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end('{"ok":true}');
          ctx.ui.notify(`📱 確認応答: confirmId=${confirmId} → ${confirmed ? "Yes" : "No"}`, "info");
        } else {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "confirmId(boolean) required" }));
        }
      } catch (e: unknown) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: e instanceof Error ? e.message : "parse error" }));
      }
      return;
    }

    if (pathname === "/sessions") {
      const sessions = await listSessionViews();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions, current: sessionId }));
      return;
    }

    if (req.method === "POST" && pathname === "/kill-session") {
      const body = await readBody(req);
      try {
        const { pid: targetPid } = JSON.parse(body);
        if (typeof targetPid !== "number") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "pid (数値) は必須です" }));
          return;
        }
        // 自分自身の終了は拒否
        if (targetPid === process.pid) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "現在接続中のセッションは終了できません" }));
          return;
        }
        // herdr ペインで動いているものはペインごと閉じる (シェルだけが残らないように)
        const entry = readRegistry().find(e => e.pid === targetPid);
        const pane = entry ? matchPane(await herdrSnapshot(0), entry) : undefined;
        const killed = pane
          ? !!(await herdrJson(["pane", "close", pane.paneId]))
          : killSpawnedSession(targetPid);
        if (killed) {
          ctx.ui.notify(`📱 セッション終了: pid=${targetPid}`, "info");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "プロセスが見つかりません" }));
        }
      } catch (e: unknown) {
        res.writeHead(400, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "parse error" }));
      }
      return;
    }

    if (pathname === "/recent-dirs") {
      const dirs = getRecentProjectDirs();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ dirs }));
      return;
    }

    if (pathname === "/browse") {
      const dirParam = reqUrl.searchParams.get("path") || os.homedir();
      const resolved = path.resolve(expandTilde(dirParam));
      const entries = listSubdirectories(resolved);
      const parentDir = path.dirname(resolved);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ current: resolved, parent: parentDir !== resolved ? parentDir : null, entries }));
      return;
    }

    if (req.method === "POST" && pathname === "/spawn-session") {
      const body = await readBody(req);
      try {
        let { cwd: targetCwd } = JSON.parse(body);
        if (!targetCwd || typeof targetCwd !== "string") {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "cwd は必須です" }));
          return;
        }
    targetCwd = path.resolve(expandTilde(targetCwd));
    if (!fsSync.existsSync(targetCwd) || !fsSync.statSync(targetCwd).isDirectory()) {
          res.writeHead(400, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "ディレクトリが存在しません: " + targetCwd }));
          return;
        }
        ctx.ui.notify(`📱 新セッション起動: ${targetCwd}`, "info");
        // 起動前のレジストリ PID を記録
        const knownPids = new Set(readRegistry().map(e => e.pid));
        // herdr 配下なら herdr のタブとして起動 (TUI で見えるセッションにする)。失敗時のみ headless rpc
        const paneId = HERDR_ON ? await spawnInHerdr(targetCwd) : null;
        if (!paneId) spawnPiSession(targetCwd);
        // sessions.json に新エントリが登録されるのを待つ
        const entry = await waitForSpawnedSession(knownPids, paneId ?? undefined);
        if (entry) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, session: entry }));
          ctx.ui.notify(`📱 新セッション起動完了: ${entry.sessionId} (pid=${entry.pid})`, "success");
        } else {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "セッション起動がタイムアウトしました" }));
        }
      } catch (e: unknown) {
        res.writeHead(500, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : "起動失敗" }));
      }
      return;
    }

    if (pathname === "/models") {
      const available = ctx.modelRegistry.getAvailable();
      const current = ctx.model;
      const models = available.map((m: any) => ({
        provider: m.provider,
        id: m.id,
        name: m.name || m.id,
        reasoning: !!m.reasoning,
      }));
      const currentId = current ? `${current.provider}/${current.id}` : "";
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ models, current: currentId }));
      return;
    }

    if (req.method === "POST" && pathname === "/set-model") {
      const body = await readBody(req);
      try {
        const { provider, id } = JSON.parse(body);
        const available = ctx.modelRegistry.getAvailable();
        const target = available.find((m: any) => m.provider === provider && m.id === id);
        if (!target) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false, error: "モデルが見つかりません" }));
          return;
        }
        const ok = await piApi.setModel(target);
        if (ok) {
          ctx.ui.notify(`📱 モデル切替: ${provider}/${id}`, "info");
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok }));
      } catch {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: false, error: "リクエスト不正" }));
      }
      return;
    }

    if (req.method === "POST" && pathname === "/interrupt") {
      ctx.ui.notify("🛑 リモート中断要求", "warning");
      try { ctx.abort(); } catch {}
      pushEvent(sessionId, { type: "agent:interrupted" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  });

  httpServer.listen(port, "0.0.0.0", () => {
    ctx.ui.setStatus("remote-ctrl", ctx.ui.theme.fg("success", `📱 :${port}`));
    const directUrl = `http://${getTailscaleIP()}:${port}`;
    let sessionFile: string | undefined;
    try { sessionFile = ctx.sessionManager.getSessionFile?.() ?? undefined; } catch {}
    registerSession({ sessionId, port, url, directUrl, workingDir, pid: process.pid, paneId: process.env.HERDR_PANE_ID, sessionFile, lastPrompt });
    startHubWatcher(port);
    // 他の拡張（Python LSP 等）の session_start 通知が出終わった後に表示されるよう遅延
    setTimeout(() => {
      try {
        ctx.ui.notify([
          `📱 Remote Control: ポート ${port}`,
          `URL: ${url}`,
          `Session: ${sessionId} | Dir: ${workingDir}`,
          `/remote-toggle で切替え | /remote-status で詳細`,
        ].join("\n"), "info");
      } catch {
        // ctx が session 切替後に stale になった場合は無視
      }
    }, 1500);
  });

  httpServer.on("error", (err: Error) => {
    ctx.ui.notify(`📱 エラー: ${err.message}`, "error");
    occupiedPorts.delete(port);
  });

  return { port, url };
}

function stopServer(sessionId: string): void {
  const s = sessionServers.get(sessionId);
  if (!s) return;
  pushEvent(sessionId, { type: "server:shutdown" });
  for (const wc of s.waitingClients.values()) clearTimeout(wc.timer);
  s.httpServer.close(() => {});
  occupiedPorts.delete(s.port);
  sessionServers.delete(sessionId);
  unregisterSession(sessionId);
  releaseHub();
}

export default function (pi: ExtensionAPI) {
  let serverPort: number | null = null;
  let remoteUrl = "";
  let sessionId = "";
  let workingDir = "";
  let isRemoteEnabled = true;
  let isServerRunning = false;

  // リモート確認APIを公開 — file-delete-guard 等から利用可能
  (globalThis as any).__remoteConfirm = requestWebConfirm;
  (globalThis as any).__remoteRespond = respondWebConfirm;
  // TUI側が先に応答した場合にWEB UI側を閉じる
  (globalThis as any).__remoteCancelConfirm = cancelWebConfirm;

  pi.on("session_start", async (_e, ctx) => {
    workingDir = ctx.cwd;
    sessionId = crypto.randomUUID().slice(0, 8);
    if (!isRemoteEnabled) {
      ctx.ui.setStatus("remote-ctrl", ctx.ui.theme.fg("dim", "📱 off"));
      return;
    }
    try {
      const result = await startServer(sessionId, workingDir, ctx, pi);
      serverPort = result.port;
      remoteUrl = result.url;
      isServerRunning = true;
    } catch (e: unknown) {
      ctx.ui.notify(`📱 起動失敗: ${e instanceof Error ? e.message : e}`, "error");
    }
  });

  pi.on("agent_start", async (_e, ctx) => {
    if (!isServerRunning) return;
    pushEvent(sessionId, { type: "agent:processing" });
    ctx.ui.setStatus("remote-ctrl", ctx.ui.theme.fg("accent", `📱 :${serverPort}`));
  });

  // ホスト側・Web UI 双方のユーザーメッセージを配信
  pi.on("message_start", async (event: any) => {
    if (!isServerRunning) return;
    if (event.message?.role !== "user") return;
    const text = extractText(event.message);
    if (text) {
      pushEvent(sessionId, { type: "user:message", text });
      patchRegistry(sessionId, { lastPrompt: text.replace(/\s+/g, " ").slice(0, 120) });
    }
  });

  // ストリーミング中のアシスタントメッセージ更新（200ms 間引き）
  let lastPushTime = 0;
  pi.on("message_update", async (event: any) => {
    if (!isServerRunning) return;
    if (event.message?.role !== "assistant") return;
    const text = extractText(event.message);
    if (!text) return;
    const now = Date.now();
    if (now - lastPushTime < 200) return;
    lastPushTime = now;
    pushEvent(sessionId, { type: "response:update", text });
  });

  pi.on("message_end", async (event: any) => {
    if (!isServerRunning) return;
    if (event.message?.role !== "assistant") return;
    const text = extractText(event.message);
    pushEvent(sessionId, { type: "response:done", text });
  });

  pi.on("model_select", async (event: any) => {
    if (!isServerRunning) return;
    const m = event.model;
    if (m) pushEvent(sessionId, { type: "model:changed", provider: m.provider, modelId: m.id });
  });

  pi.on("agent_end", async (_e, ctx) => {
    if (!isServerRunning) return;
    pushEvent(sessionId, { type: "agent:complete" });
    ctx.ui.setStatus("remote-ctrl", ctx.ui.theme.fg("success", `📱 :${serverPort}`));
  });

  pi.on("tool_result", async (event, _ctx) => {
    if (!isServerRunning) return;
    const { toolName, isError } = event;
    const input = (event as Record<string, unknown>).input;
    pushEvent(sessionId, {
      type: "tool:result",
      toolName,
      isError,
      toolInput: input ? JSON.stringify(input).slice(0, 200) : undefined,
    });
  });

  pi.on("session_shutdown", async () => {
    if (isServerRunning) stopServer(sessionId);
    serverPort = null;
    isServerRunning = false;
  cleanupSpawnedSessions();
    // shutdown時にグローバル参照をクリア
    delete (globalThis as any).__remoteConfirm;
    delete (globalThis as any).__remoteRespond;
  });

  pi.registerCommand("remote-status", {
    description: "リモートコントロールの状態を表示",
    handler: async (_args, ctx) => {
      if (!serverPort) {
        ctx.ui.notify("📱 無効\n/remote-toggle で有効化", "info");
        return;
      }
      const s = sessionServers.get(sessionId);
      ctx.ui.notify(
        `📱 Remote Control\nポート: ${serverPort}\nURL: ${remoteUrl}\nSession: ${sessionId}\n待機クライアント: ${s?.waitingClients.size ?? 0}`,
        "info",
      );
    },
  });

  pi.registerCommand("remote-toggle", {
    description: "リモートコントロールのオン/オフ",
    handler: async (_args, ctx) => {
      isRemoteEnabled = !isRemoteEnabled;
      if (isRemoteEnabled) {
        try {
          const result = await startServer(sessionId, workingDir, ctx, pi);
          serverPort = result.port;
          remoteUrl = result.url;
          isServerRunning = true;
          ctx.ui.notify(`📱 有効化: ${remoteUrl}`, "success");
          ctx.ui.setStatus("remote-ctrl", ctx.ui.theme.fg("success", `📱 :${serverPort}`));
        } catch (e: unknown) {
          ctx.ui.notify(`📱 起動失敗: ${e instanceof Error ? e.message : e}`, "error");
        }
      } else {
        if (isServerRunning) stopServer(sessionId);
        serverPort = null;
        isServerRunning = false;
        ctx.ui.setStatus("remote-ctrl", ctx.ui.theme.fg("dim", "📱 off"));
        ctx.ui.notify("📱 無効化", "info");
      }
    },
  });
}
