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
import { execSync } from "node:child_process";
import os from "node:os";

// ─── 型定義 ────────────────────────────────────────────────────

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

// ─── 確認ダイアログ管理 ────────────────────────────────────────

interface PendingConfirm {
  id: string;
  title: string;
  message: string;
  resolve: (confirmed: boolean) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingConfirms = new Map<string, PendingConfirm>();

/** 拡張機能が確認ダイアログを要求 → Web UIに配信し、応答を待つ */
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

/** Web UIから確認レスポンスを受信 → 待機中のPromiseを解決 */
function respondWebConfirm(confirmId: string, confirmed: boolean): void {
  const pending = pendingConfirms.get(confirmId);
  if (pending) {
    clearTimeout(pending.timer);
    pendingConfirms.delete(confirmId);
    pending.resolve(confirmed);
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

// ─── プロセス内状態 ────────────────────────────────────────────

const occupiedPorts = new Set<number>();
const sessionServers = new Map<string, ServerInstance>();

// ─── プロセス間共有セッションレジストリ（ファイルベース） ──────

const REGISTRY_PATH = path.join(os.homedir(), ".pi", "remote-control", "sessions.json");

interface RegistryEntry {
  sessionId: string;
  port: number;
  url: string;
  directUrl: string; // Tailscale IP + ポートの直接URL（セッション切り替え用）
  workingDir: string;
  pid: number;
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
  } catch { /* ignore */ }
}

function registerSession(entry: RegistryEntry): void {
  const entries = readRegistry().filter(e => e.sessionId !== entry.sessionId);
  entries.push(entry);
  writeRegistry(entries);
}

function unregisterSession(sessionId: string): void {
  writeRegistry(readRegistry().filter(e => e.sessionId !== sessionId));
}

// ─── ユーティリティ ────────────────────────────────────────────

/** AgentMessage から テキスト部分を抽出 */
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

/** HTTP リクエストボディを読み取る */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (c: Buffer) => (body += c));
    req.on("end", () => resolve(body));
  });
}

// ─── Tailscale ─────────────────────────────────────────────────

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

/** Tailscale の IPv4 アドレスを取得（フォールバック） */
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
  } catch { /* ignore */ }
}

/** リモートアクセス URL を生成 */
function buildRemoteUrl(port: number, fqdn: string, useTailscaleServe: boolean): string {
  if (useTailscaleServe && fqdn) {
    return `https://${fqdn}${SERVE_PATH}`;
  }
  return `http://${getTailscaleIP()}:${port}`;
}

// ─── ポート検索 ────────────────────────────────────────────────

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
    } catch { /* 使用中 */ }
  }
  throw new Error(`ポート ${start}〜 が全て使用中です`);
}

// ─── Web UI HTML ───────────────────────────────────────────────

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
#sess{font-size:11px;color:var(--dm);cursor:pointer;padding:4px 8px;border-radius:8px;background:var(--bg);border:1px solid var(--bd);white-space:nowrap;flex-shrink:0}
#sess:active{background:var(--bd)}
/* ── 確認ダイアログ ───────────────────────── */
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
</style>
</head>
<body>

<div class="hd">
  <div id="dot" class="dot"></div>
  <div class="ht">Pi Remote</div>
  <div id="mdl" onclick="openModelPicker()">---</div>
  <div id="sess" onclick="openSessionPicker()"></div>
  <div id="hm" class="hm"></div>
</div>

<div id="sessOverlay" class="overlay" onclick="closeSessionPicker()">
  <div class="modal" onclick="event.stopPropagation()">
    <div class="modal-title">セッション切替</div>
    <div id="sessList" class="modal-list"></div>
  </div>
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
const BASE=(()=>{const p=location.pathname.replace(/\\/$/, '');return p||'';})();
function api(path){return BASE+path;}
const msgs=$("msgs"), inp=$("inp"), dot=$("dot"), hm=$("hm"), sndBtn=$("snd"), stpBtn=$("stp");
let lastId=0, processing=false, streamEl=null, sentLocally=false;
let currentConfirmId=null, confirmTimerEl=null;

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

// ── 確認ダイアログ ────────────────────────
function showConfirm(confirmId, title, message, timeoutSec) {
  currentConfirmId = confirmId;
  $("confirmTitle").textContent = title;
  $("confirmBody").textContent = message;
  $("confirmOverlay").classList.add("show");
  // タイマー表示
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

// ── 通信 ──────────────────────────────────────────────

async function init(){
  try{
    const r=await fetch(api("/poll?since=0"));
    const d=await r.json();
    if(d.sessionId){
      dot.className="dot ok";
      updateSessionLabel(d.sessionId);
      hm.textContent=":"+d.port;
      addM("s","🔗 接続完了 ("+d.sessionId+")");
      handleEvents(d.events||[]);
      fetchModels();
      streamLoop();
    }
  }catch(e){ setTimeout(init,2000); }
}

async function streamLoop(){
  while(true){
    try{
      const r=await fetch(api("/stream?since="+lastId));
      const d=await r.json();
      dot.className="dot ok";
      handleEvents(d.events||[]);
    }catch(e){
      dot.className="dot wait";
      await new Promise(r=>setTimeout(r,2000));
    }
  }
}

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

// ── UI イベント ───────────────────────────────────────

sndBtn.onclick=send;
stpBtn.onclick=interrupt;

// ── セッション切替 ───────────────────────────────
const sessBtn=$('sess'), sessOverlay=$('sessOverlay'), sessList=$('sessList');

function updateSessionLabel(sid){
  sessBtn.textContent='📁 '+sid;
}

async function openSessionPicker(){
  try{
    const r=await fetch(api('/sessions'));
    const d=await r.json();
    const sessions=d.sessions||[];
    const cur=d.current||'';
    sessList.innerHTML='';
    if(sessions.length<=1){
      sessList.innerHTML='<div class="modal-item" style="color:var(--dm);justify-content:center">他のセッションなし</div>';
    }
    for(const s of sessions){
      const item=document.createElement('div');
      item.className='modal-item'+(s.sessionId===cur?' active':'');
      const dir=s.workingDir.split('/').slice(-2).join('/');
      item.innerHTML=
        '<span class="mi-check">'+(s.sessionId===cur?'✓':'')+
        '</span><span class="mi-name">'+dir+
        '</span><span class="mi-prov">:'+s.port+'</span>';
      item.onclick=()=>{
        if(s.sessionId!==cur) window.location.href=s.directUrl||s.url;
        closeSessionPicker();
      };
      sessList.appendChild(item);
    }
    sessOverlay.classList.add('show');
  }catch(e){}
}

function closeSessionPicker(){ sessOverlay.classList.remove('show'); }

// ── モデル選択 ─────────────────────────────────
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

// ─── サーバー起動・停止 ────────────────────────────────────────

async function startServer(
  sessionId: string,
  workingDir: string,
  ctx: ExtensionContext,
  piApi: ExtensionAPI,
): Promise<{ port: number; url: string }> {
  const port = await findAvailablePort(8920);
  const html = generateHTML();

  const fqdn = getTailscaleFQDN();
  const useTailscaleServe = !!fqdn && setupTailscaleServe(port);
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
  try {
    const history = ctx.sessionManager.buildSessionContext();
    for (const msg of history.messages) {
      const text = extractText(msg);
      if (!text) continue;
      if (msg.role === "user") {
        pushEvent(sessionId, { type: "user:message", text });
      } else if (msg.role === "assistant") {
        pushEvent(sessionId, { type: "response:done", text });
      }
    }
  } catch { /* セッション履歴がない場合は無視 */ }

  httpServer.on("request", async (req: http.IncomingMessage, res: http.ServerResponse) => {
    const reqUrl = new URL(req.url || "/", `http://${req.headers.host}`);
    const pathname = reqUrl.pathname;

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
      } catch { /* invalid JSON */ }
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

    // 全アクティブセッション一覧
    if (pathname === "/sessions") {
      const sessions = readRegistry();
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ sessions, current: sessionId }));
      return;
    }

    // モデル一覧取得
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

    // モデル切り替え
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

    // 中断要求
    if (req.method === "POST" && pathname === "/interrupt") {
      ctx.ui.notify("🛑 リモート中断要求", "warning");
      pushEvent(sessionId, { type: "agent:interrupted" });
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end('{"ok":true}');
      return;
    }

    // Web UI
    res.writeHead(200, {
      "Content-Type": "text/html; charset=UTF-8",
      "Cache-Control": "no-cache, no-store, must-revalidate",
      "Pragma": "no-cache",
      "Expires": "0",
    });
    res.end(html);
  });

  httpServer.listen(port, "0.0.0.0", () => {
    ctx.ui.notify([
      `📱 Remote Control: ポート ${port}`,
      `URL: ${url}`,
      `Session: ${sessionId} | Dir: ${workingDir}`,
      `/remote-toggle で切替え | /remote-status で詳細`,
    ].join("\n"), "info");
    ctx.ui.setStatus("remote-ctrl", ctx.ui.theme.fg("success", `📱 :${port}`));
    const directUrl = `http://${getTailscaleIP()}:${port}`;
    registerSession({ sessionId, port, url, directUrl, workingDir, pid: process.pid });
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
  teardownTailscaleServe();
}

// ─── 拡張機能エントリーポイント ────────────────────────────────

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
    if (text) pushEvent(sessionId, { type: "user:message", text });
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

  // メッセージ完了時に最終テキストを送信
  pi.on("message_end", async (event: any) => {
    if (!isServerRunning) return;
    if (event.message?.role !== "assistant") return;
    const text = extractText(event.message);
    pushEvent(sessionId, { type: "response:done", text });
  });

  // モデル変更をWeb UIに通知
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
