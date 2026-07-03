// compaction-capture — OpenClaw file-hook. Fires on session:compact:before (OBSERVE-ONLY: it cannot
// stop compaction). Best-effort: it snapshots the about-to-be-trimmed window into the indexed memory
// store and queues high-signal lines for the agent to curate. Pure code, provider-free, never throws.
//
// Two honest realities it handles (see HOOK.md):
//   • If the runtime exposes message CONTENT on the event (objects with role/content), we snapshot it.
//   • If it exposes METADATA only (the documented file-hook contract), we still write an indexed
//     breadcrumb + nudge the agent — the raw window stays recoverable via `mdeep`'s transcript index.
//
// The heavy lifting lives in the shared, dependency-free capture.mjs (dynamically imported so a resolve
// failure degrades gracefully instead of breaking hook registration).

const handler = async (event) => {
  try {
    if (!event || event.type !== "session" || event.action !== "compact:before") return;

    const ctx = event.context || {};
    // Workspace must match store.mjs so the snapshot lands in the store msem/mdeep index.
    const ws = ctx.workspace || ctx.workspacePath || ctx.cwd
      || process.env.OPENCLAW_WORKSPACE || `${process.env.HOME || ""}/.openclaw/workspace`;

    // Defensively locate real message content on the event (shape varies by runtime/version). We accept
    // a candidate only if it's an array containing objects — a plain string[] is the nudge channel, not
    // a transcript, and is handled below instead.
    const candidates = [event.messages, ctx.messages, event.transcript, ctx.transcript, event.payload && event.payload.messages];
    let raw = [];
    for (const c of candidates) {
      if (Array.isArray(c) && c.some((x) => x && typeof x === "object")) { raw = c; break; }
    }

    let count = 0, queued = 0, mode = "self";
    try {
      const cap = await import(new URL("./capture.mjs", import.meta.url).href);
      const messages = cap.normalizeMessages(raw);
      count = messages.length;
      // captureWindow references smart-cache-pro's verbatim copy when present (no duplicate), else self-snapshots.
      const res = cap.captureWindow({
        ws,
        messages,
        meta: {
          trigger: event.trigger || ctx.trigger || "auto",
          source: "openclaw:before_compaction",
          capturedAt: new Date().toISOString(),
        },
      });
      queued = res.queued;
      mode = res.mode;
    } catch (e) {
      console.warn(`[compaction-capture] snapshot skipped: ${e instanceof Error ? e.message : String(e)}`);
    }

    // Nudge the agent — but only when event.messages is the string 'nudge channel' (empty, or string[]),
    // never a real transcript array (we already snapshotted that above; a stray string would pollute it).
    const msgs = event.messages;
    if (Array.isArray(msgs) && (msgs.length === 0 || typeof msgs[0] === "string")) {
      const how = mode === "reference"
        ? "referenced smart-cache-pro's verbatim copy + indexed the window"
        : "snapshotted the window";
      msgs.push(
        `🧠 cognitive-memory: context is compacting — ${how} to memory/.compaction/ ` +
        `(${count} msgs, ${queued} flagged). When you have a moment, curate ` +
        `memory/.compaction/curation-queue.md (promote keepers via scripts/save.sh).`,
      );
    }
  } catch (error) {
    console.warn(`[compaction-capture] failed: ${error instanceof Error ? error.message : String(error)}`);
  }
};

export default handler;
