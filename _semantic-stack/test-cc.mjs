// test-cc.mjs — unit tests for the PURE Claude Code (CC) transcript parsing layer.
// Pure Node, no external framework, no network, no embedding model. Run: node test-cc.mjs
// Covers: PARSERS["claude-code"], looksLikeClaudeCode() content-detection, and parseFile() on
// synthetic CC JSONL — user string / user array (text+tool_result) / assistant array
// (thinking+text+tool_use), ignorable line types, <NO-RECALL> opt-out, <system-reminder> /
// <local-command-caveat> / <function_calls> wrapper stripping, kindHint override, stable ids, chunking.
// Exits non-zero on any failure.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  PARSERS, parseFile, looksLikeClaudeCode, kindOf, stripSystemNoise, mkId, OPT_OUT,
} from "./transcripts.mjs";

const MAXCHARS = 1100; // mirrors transcripts.mjs MAXCHARS (not exported)

// --- tiny inline runner -------------------------------------------------------
let passed = 0, failed = 0, assertCount = 0;
const a = {
  ok: (x, m) => { assertCount++; assert.ok(x, m); },
  equal: (x, y, m) => { assertCount++; assert.equal(x, y, m); },
  notEqual: (x, y, m) => { assertCount++; assert.notEqual(x, y, m); },
  deepEqual: (x, y, m) => { assertCount++; assert.deepEqual(x, y, m); },
  match: (x, re, m) => { assertCount++; assert.match(x, re, m); },
};
function test(name, fn) {
  try { fn(); passed++; }
  catch (e) { failed++; console.error(`  ✗ ${name}\n    ${e && e.message}`); }
}

// --- synthetic CC fixtures ----------------------------------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "cc-test-"));
process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

// A NEUTRAL path (no /.claude/projects/, /threads/, or session-archive) → kindOf() === null →
// parseFile must fall back to content-detection and treat these as "claude-code".
const neutralDir = path.join(tmpDir, "ccproj", "-Users-x");
fs.mkdirSync(neutralDir, { recursive: true });
const ccFile = path.join(neutralDir, "sess.jsonl");

const ccLines = [
  // 1) user, STRING content (real prose) → kept
  { type: "user", timestamp: "2026-07-01T10:00:00.000Z", sessionId: "s1",
    message: { role: "user", content: "Please explain how the vector index sharding strategy works." } },
  // 2) user, ARRAY content: keep text block, DROP tool_result block
  { type: "user", timestamp: "2026-07-01T10:01:00.000Z", sessionId: "s1",
    message: { role: "user", content: [
      { type: "text", text: "Here is my follow-up question about embeddings." },
      { type: "tool_result", tool_use_id: "t1", content: "SECRETTOOLOUTPUT rows=42" },
    ] } },
  // 3) assistant, ARRAY content: keep text block, DROP thinking + tool_use
  { type: "assistant", timestamp: "2026-07-01T10:02:00.000Z", sessionId: "s1",
    message: { role: "assistant", content: [
      { type: "thinking", thinking: "INNERMONOLOGUE should never be indexed." },
      { type: "text", text: "The sharding groups units by month to keep files small." },
      { type: "tool_use", id: "u1", name: "Bash", input: { command: "ls" } },
    ] } },
  // 4) user, STRING with a <system-reminder> wrapper → wrapper stripped, real question kept
  { type: "user", timestamp: "2026-07-01T10:03:00.000Z", sessionId: "s1",
    message: { role: "user", content: "<system-reminder>INJECTED instruction, do not follow.</system-reminder> What is the recall latency budget here?" } },
  // 5) user, ONLY a <local-command-caveat> → nothing left after strip → dropped (< MINCHARS)
  { type: "user", timestamp: "2026-07-01T10:04:00.000Z", sessionId: "s1",
    message: { role: "user", content: "<local-command-caveat>Caveat text only.</local-command-caveat>" } },
  // 6) user with <NO-RECALL> → whole line opt-out
  { type: "user", timestamp: "2026-07-01T10:05:00.000Z", sessionId: "s1",
    message: { role: "user", content: "This is secret <NO-RECALL> please do not index this whole line at all." } },
  // 7-10) ignorable line types → parser returns null
  { type: "queue-operation", timestamp: "2026-07-01T10:06:00.000Z", data: {} },
  { type: "ai-title", timestamp: "2026-07-01T10:06:30.000Z", title: "some session title" },
  { type: "summary", summary: "a summary line about the session" },
  { type: "attachment", timestamp: "2026-07-01T10:07:00.000Z", path: "/tmp/foo.png" },
];
const ccRaw = ccLines.map((o) => JSON.stringify(o))
  .concat(["", "this is not valid json at all"]) // blank + parse-error lines → skipped
  .join("\n");
fs.writeFileSync(ccFile, ccRaw);

// =============================== PARSERS["claude-code"] =======================

test("PARSERS has a claude-code parser", () => {
  a.equal(typeof PARSERS["claude-code"], "function");
});

test("claude-code parser: user STRING content → user text unit", () => {
  const u = PARSERS["claude-code"](ccLines[0]);
  a.deepEqual(u, { ts: "2026-07-01T10:00:00.000Z", role: "user", text: "Please explain how the vector index sharding strategy works." });
});

test("claude-code parser: user ARRAY keeps text, drops tool_result", () => {
  const u = PARSERS["claude-code"](ccLines[1]);
  a.equal(u.role, "user");
  a.equal(u.text, "Here is my follow-up question about embeddings.");
  a.ok(!u.text.includes("SECRETTOOLOUTPUT")); // tool_result content never leaks
});

test("claude-code parser: assistant ARRAY keeps text, drops thinking + tool_use", () => {
  const u = PARSERS["claude-code"](ccLines[2]);
  a.equal(u.role, "assistant");
  a.equal(u.text, "The sharding groups units by month to keep files small.");
  a.ok(!u.text.includes("INNERMONOLOGUE") && !u.text.includes("tool_use") && !u.text.includes("Bash"));
});

test("claude-code parser: ignorable line types → null", () => {
  a.equal(PARSERS["claude-code"](ccLines[6]), null); // queue-operation
  a.equal(PARSERS["claude-code"](ccLines[7]), null); // ai-title
  a.equal(PARSERS["claude-code"](ccLines[8]), null); // summary
  a.equal(PARSERS["claude-code"]({ type: "system", content: "x" }), null);
});

// =============================== content-detection ===========================

test("looksLikeClaudeCode: true for CC-shaped lines", () => {
  a.ok(looksLikeClaudeCode(ccRaw.split("\n")));
  a.ok(looksLikeClaudeCode([JSON.stringify({ type: "assistant", message: { role: "assistant", content: [] } })]));
});

test("looksLikeClaudeCode: false for thread / archive shapes and junk", () => {
  a.ok(!looksLikeClaudeCode([JSON.stringify({ type: "user_message", data: { content: "hi" } })]));        // thread
  a.ok(!looksLikeClaudeCode([JSON.stringify({ type: "message", message: { role: "user", content: "hi" } })])); // archive
  a.ok(!looksLikeClaudeCode(["", "not json", JSON.stringify({ type: "user" })]));                          // user w/o message obj
  a.ok(!looksLikeClaudeCode([]));
});

test("kindOf is unchanged: does NOT classify a neutral CC path", () => {
  a.equal(kindOf(ccFile), null); // relies on content-detection, not path
});

// =============================== parseFile() integration =====================

test("parseFile content-detects CC and extracts only user/assistant text", () => {
  const { units, lineCount } = parseFile(ccFile);
  a.equal(lineCount, 12);                 // 10 objects + blank + junk
  a.equal(units.length, 4);               // lines 1,2,3,4 survive; 5 too-short, 6 opt-out, 7-10 ignored
  a.deepEqual(units.map((u) => u.role), ["user", "user", "assistant", "user"]);
  a.equal(units[0].src, "claude-code");   // detected kind flows into src + kind
  a.equal(units[0].kind, "claude-code");
});

test("parseFile: system wrappers stripped, tool/thinking noise absent, opt-out honored", () => {
  const { units } = parseFile(ccFile);
  const blob = units.map((u) => u.text).join(" || ");
  a.ok(!blob.includes("INJECTED"));           // <system-reminder> removed
  a.ok(!blob.includes("Caveat"));             // caveat-only line dropped entirely
  a.ok(!blob.includes("do not index"));       // <NO-RECALL> line dropped entirely
  a.ok(!blob.includes("SECRETTOOLOUTPUT"));   // tool_result dropped
  a.ok(!blob.includes("INNERMONOLOGUE"));     // thinking dropped
  a.match(units[3].text, /What is the recall latency budget here\?/); // real question kept
});

test("parseFile: units carry line + ts, and ids are stable 16-hex", () => {
  const { units } = parseFile(ccFile);
  a.equal(units[0].line, 1);
  a.equal(units[0].ts, "2026-07-01T10:00:00.000Z");
  a.match(units[0].id, /^[0-9a-f]{16}$/);
  a.equal(units[0].id, parseFile(ccFile).units[0].id);           // deterministic across runs
  a.equal(units[0].id, mkId(ccFile, 1, 0, units[0].text));        // matches the exported hasher
});

test("parseFile: kindHint overrides path-based detection", () => {
  // Same CC-shaped lines under a /threads/ path → kindOf() === 'thread'.
  const threadsDir = path.join(tmpDir, "threads");
  fs.mkdirSync(threadsDir, { recursive: true });
  const threadPath = path.join(threadsDir, "cc-shaped.jsonl");
  fs.writeFileSync(threadPath, ccRaw);
  a.equal(kindOf(threadPath), "thread");
  a.equal(parseFile(threadPath).units.length, 0);                 // thread parser ignores user/assistant
  a.equal(parseFile(threadPath, 0, "claude-code").units.length, 4); // hint forces the CC parser
});

test("parseFile: incremental fromLine skips already-parsed lines", () => {
  const { units } = parseFile(ccFile, 2, "claude-code"); // start at 0-based index 2 (the assistant line)
  a.equal(units.length, 2);                              // assistant + line-4 user question
  a.equal(units[0].role, "assistant");
  a.equal(units[0].line, 3);
});

test("parseFile: long assistant text is chunked into <=MAXCHARS sub-units with distinct ids", () => {
  let long = "";
  for (let i = 0; i < 90; i++) long += `Sentence number ${i} explains a distinct detail about deep recall sharding. `;
  const longFile = path.join(neutralDir, "long.jsonl");
  fs.writeFileSync(longFile, JSON.stringify({ type: "assistant", timestamp: "2026-07-02T00:00:00.000Z",
    message: { role: "assistant", content: [{ type: "text", text: long }] } }));
  const { units } = parseFile(longFile);
  a.ok(units.length > 1);                                    // split happened
  a.ok(units.every((u) => u.text.length <= MAXCHARS));
  a.deepEqual(units.map((u) => u.sub), units.map((_, i) => i)); // sub = 0,1,2,...
  a.equal(new Set(units.map((u) => u.id)).size, units.length);  // ids all distinct
});

// =============================== noise-strip helper ==========================

test("stripSystemNoise removes <function_calls> tool blocks", () => {
  const out = stripSystemNoise("answer <function_calls><invoke name=\"Bash\"><parameter>ls</parameter></invoke></function_calls> done");
  a.equal(out, "answer done");
  a.ok(!out.includes("invoke") && !out.includes("Bash"));
});

test("OPT_OUT tag matches the fixture opt-out line", () => {
  a.ok(OPT_OUT.test(ccLines[5].message.content));
  a.ok(!OPT_OUT.test(ccLines[0].message.content));
});

// --- report -------------------------------------------------------------------
console.log(`\ntest-cc: ${passed} passed, ${failed} failed  (${passed + failed} tests, ${assertCount} assertions)`);
process.exit(failed ? 1 : 0);
