// Harness: load the extension with a stubbed pi API and start one session server.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const { createJiti } = require(process.env.JITI_PATH);
const jiti = createJiti(import.meta.url, { interopDefault: true });
const ext = await jiti.import(new URL("../extensions/index.ts", import.meta.url).pathname);
const handlers = {};
const pi = {
  on: (n, h) => (handlers[n] = h),
  registerCommand() {},
  sendUserMessage() {},
  setModel: async () => true,
};
const ctx = {
  cwd: process.env.FAKE_CWD || "/tmp",
  abort: () => console.log("ABORTED"),
  ui: { notify() {}, setStatus() {}, theme: { fg: (_, t) => t } },
  sessionManager: { buildSessionContext: () => ({ messages: [{role:"system",content:"sys"},{role:"user",content:[{type:"text",text:"hello there"}]},{role:"assistant",content:[{type:"text",text:"hi"}]}] }), getSessionFile: () => "/x/y.jsonl" },
  modelRegistry: { getAvailable: () => [] },
};
(ext.default ?? ext)(pi);
await handlers.session_start({}, ctx);
console.log("READY");
process.on("SIGTERM", async () => { await handlers.session_shutdown({}); process.exit(0); });
setInterval(() => {}, 1000);
