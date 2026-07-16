// embed-daemon.mjs — persistent local embedding server. Loads the ~1.1GB arctic-embed model ONCE and
// serves embed requests over a Unix socket, so msem/mdeep/reconcile/save stop cold-starting the model on
// every call. Purely additive + optional: if this isn't running, common.mjs's embed() cold-loads exactly
// as before (zero behaviour change). Idle-shuts-down after MEM_EMBED_IDLE_MS to release the model's RAM.
// Control it with the `memd` wrapper (start|stop|status|restart).
//
// Protocol (newline-delimited JSON over a Unix socket; JSON.stringify never emits a raw newline):
//   request:  {"text":"..."}\n     response:  {"vector":[...]}\n   or   {"error":"..."}\n
import net from "node:net";
import { WS, embedInProcess, dispose, EMBED_SOCK, fs, path } from "./common.mjs";

const SOCK = EMBED_SOCK;
const PIDF = `${WS}/memory/.semantic/embed.pid`;
const IDLE_MS = Number(process.env.MEM_EMBED_IDLE_MS || 15 * 60 * 1000);

fs.mkdirSync(path.dirname(SOCK), { recursive: true });   // socket dir (short /tmp path)
fs.mkdirSync(path.dirname(PIDF), { recursive: true });   // workspace .semantic (pid + log)

function cleanup() { try { fs.unlinkSync(SOCK); } catch {} try { fs.unlinkSync(PIDF); } catch {} }
function shutdown(code) { cleanup(); dispose().catch(() => {}).finally(() => process.exit(code)); }

let idle;
function armIdle() { clearTimeout(idle); idle = setTimeout(() => { console.error("embed-daemon: idle timeout, shutting down"); shutdown(0); }, IDLE_MS); }

const server = net.createServer((conn) => {
  clearTimeout(idle);
  let buf = "";
  conn.on("data", async (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl); buf = buf.slice(nl + 1);
      if (!line.trim()) continue;
      try {
        const { text } = JSON.parse(line);
        const vector = await embedInProcess(String(text ?? ""));
        conn.write(JSON.stringify({ vector }) + "\n");
      } catch (e) {
        conn.write(JSON.stringify({ error: String((e && e.message) || e) }) + "\n");
      }
    }
  });
  conn.on("error", () => {});
  conn.on("close", () => armIdle());
});

server.on("error", (e) => {
  if (e.code === "EADDRINUSE") {
    // Someone owns the socket path. If a live daemon answers, defer to it; if it's stale, reclaim.
    const probe = net.connect(SOCK, () => { probe.destroy(); console.error("embed-daemon: already running at " + SOCK); process.exit(0); });
    probe.on("error", () => { try { fs.unlinkSync(SOCK); } catch {} server.listen(SOCK); });
  } else { console.error("embed-daemon: " + e.message); process.exit(1); }
});

server.listen(SOCK, () => {
  try { fs.writeFileSync(PIDF, String(process.pid)); } catch {}
  console.error(`embed-daemon: listening ${SOCK} (pid ${process.pid}, idle ${IDLE_MS}ms). Warming model…`);
  // Warm the model immediately so the first real request is already fast (getCtx de-dups the load).
  embedInProcess("warmup").then(() => console.error("embed-daemon: model warm, ready")).catch((e) => console.error("embed-daemon: warm failed: " + ((e && e.message) || e)));
  armIdle();
});

for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, () => { console.error(`embed-daemon: ${sig}, shutting down`); shutdown(0); });
