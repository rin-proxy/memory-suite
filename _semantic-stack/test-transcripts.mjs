// test-transcripts.mjs — unit tests for the PURE parsing + redaction layer.
// Pure Node, no external framework, no network, no embedding model. Run: node test-transcripts.mjs
// Covers transcripts.mjs (3-format parsers, splitLong, noise-strip, <NO-RECALL> opt-out, dedup id)
// and redact.mjs (every redaction rule, positive + negative). Exits non-zero on any failure.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  mkId, splitLong, stripChannelMeta, stripSystemNoise, isSerializedDump,
  textFromContent, PARSERS, kindOf, parseFile, OPT_OUT,
} from "./transcripts.mjs";
import { redact } from "./redact.mjs";

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

// --- shared temp fixture for parseFile() integration --------------------------
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "transcripts-test-"));
const threadsDir = path.join(tmpDir, "threads");
fs.mkdirSync(threadsDir);
const threadFile = path.join(threadsDir, "t.jsonl"); // path contains /threads/ → kindOf === "thread"
const threadLines = [
  JSON.stringify({ type: "user_message", timestamp: "2026-06-01T10:00:00Z", data: { content: "This is a real user message about databases and indexing." } }),
  JSON.stringify({ type: "user_message", timestamp: "2026-06-01T10:01:00Z", data: { content: "Secret plan <NO-RECALL> please do not index this line at all." } }),
  JSON.stringify({ type: "user_message", timestamp: "2026-06-01T10:02:00Z", data: { content: "hi" } }), // < MINCHARS → dropped
  "",                                                                                                     // blank → skipped
  "this is not valid json",                                                                               // parse error → skipped
  JSON.stringify({ type: "decision", timestamp: "2026-06-01T10:03:00Z", data: { decision: "adopt sqlite-vec once chunks exceed ten thousand" } }),
];
fs.writeFileSync(threadFile, threadLines.join("\n"));
process.on("exit", () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch {} });

// =============================== transcripts.mjs ==============================

test("mkId is deterministic and 16-hex", () => {
  a.equal(mkId("f.jsonl", 3, 0, "hello world text"), mkId("f.jsonl", 3, 0, "hello world text"));
  a.match(mkId("f.jsonl", 3, 0, "hello world text"), /^[0-9a-f]{16}$/);
});

test("mkId differs when inputs differ", () => {
  a.notEqual(mkId("f.jsonl", 3, 0, "a"), mkId("f.jsonl", 3, 0, "b"));
  a.notEqual(mkId("f.jsonl", 3, 0, "a"), mkId("g.jsonl", 3, 0, "a"));
});

test("splitLong passes short text through unchanged", () => {
  a.deepEqual(splitLong("short text"), ["short text"]);
});

test("splitLong breaks a long multi-sentence string into <=MAXCHARS pieces", () => {
  let long = "";
  for (let i = 0; i < 120; i++) long += `This is sentence number ${i} in a very long paragraph. `;
  const pieces = splitLong(long);
  a.ok(pieces.length > 1);
  a.ok(pieces.every((p) => p.length <= MAXCHARS));
});

test("splitLong hard-splits a boundary-less blob, preserving all characters", () => {
  const blob = "a".repeat(3000);
  const pieces = splitLong(blob);
  a.ok(pieces.every((p) => p.length <= MAXCHARS));
  a.equal(pieces.join(""), blob);
});

test("stripSystemNoise removes <system-reminder> blocks and collapses whitespace", () => {
  const out = stripSystemNoise("keep this <system-reminder>secret injected instruction</system-reminder> and this");
  a.equal(out, "keep this and this");
  a.ok(!out.includes("injected"));
});

test("stripSystemNoise removes bash-input wrappers", () => {
  a.equal(stripSystemNoise("before <bash-input>rm -rf /</bash-input> after"), "before after");
});

test("stripSystemNoise leaves ordinary prose intact", () => {
  a.equal(stripSystemNoise("just normal words here"), "just normal words here");
});

test("stripChannelMeta strips the untrusted-metadata preamble", () => {
  const content =
    "Conversation info (untrusted metadata): ```json\n" +
    '{"channel":"telegram","sender_id":"123"}\n' +
    "```\n" +
    "actual user question here";
  a.equal(stripChannelMeta(content), "actual user question here");
});

test("stripChannelMeta leaves a plain message intact", () => {
  a.equal(stripChannelMeta("just a normal message"), "just a normal message");
});

test("isSerializedDump detects serialized message JSON and signature blobs", () => {
  a.ok(isSerializedDump('{"type":"text","text":"hi"}'));
  a.ok(isSerializedDump('{"signature":"' + "A".repeat(40) + '"}'));
});

test("isSerializedDump returns false for human prose", () => {
  a.ok(!isSerializedDump("just normal text about types and messages"));
});

test("textFromContent handles strings, arrays, dumps and junk", () => {
  a.equal(textFromContent("hello prose"), "hello prose");
  a.equal(textFromContent('{"type":"text","text":"x"}'), ""); // serialized dump → dropped
  const arr = textFromContent([{ type: "text", text: "alpha block" }, { type: "tool_use", id: "1" }, { type: "text", text: "beta block" }]);
  a.ok(arr.includes("alpha block") && arr.includes("beta block") && !arr.includes("tool_use"));
  a.equal(textFromContent(undefined), "");
});

test("OPT_OUT matches <NO-RECALL> case-insensitively, not ordinary text", () => {
  a.ok(OPT_OUT.test("please <no-recall> skip me"));
  a.ok(!OPT_OUT.test("this line should be recalled"));
});

test("kindOf classifies engineer / archive / thread / unknown", () => {
  a.equal(kindOf("/home/u/.claude/projects/proj/session.jsonl"), "engineer");
  a.equal(kindOf("/w/memory/session-archive-2026-06.jsonl"), "archive");
  a.equal(kindOf("/w/memory/threads/abc.jsonl"), "thread");
  a.equal(kindOf("/w/memory/notes/foo.jsonl"), null);
});

test("PARSERS.thread parses user_message / decision, ignores others", () => {
  a.deepEqual(
    PARSERS.thread({ type: "user_message", timestamp: "t", data: { content: "hello there" } }),
    { ts: "t", role: "user", text: "hello there" },
  );
  const d = PARSERS.thread({ type: "decision", timestamp: "t", data: { decision: "use sqlite", rationale: "faster" } });
  a.equal(d.role, "rin");
  a.ok(d.text.includes("use sqlite") && d.text.includes("faster"));
  a.equal(PARSERS.thread({ type: "heartbeat", data: {} }), null);
});

test("PARSERS.archive parses messages, strips user channel-meta, ignores non-messages", () => {
  const asst = PARSERS.archive({ type: "message", timestamp: "t", message: { role: "assistant", content: "assistant says hello world" } });
  a.deepEqual(asst, { ts: "t", role: "assistant", text: "assistant says hello world" });
  const meta = "Conversation info (untrusted metadata): ```json\n{\"channel\":\"x\"}\n```\nactual user question here";
  const usr = PARSERS.archive({ type: "message", timestamp: "t", message: { role: "user", content: meta } });
  a.equal(usr.text, "actual user question here");
  a.equal(PARSERS.archive({ type: "summary" }), null);
});

test("PARSERS.engineer parses user/assistant text, drops dumps and other types", () => {
  a.deepEqual(
    PARSERS.engineer({ type: "user", timestamp: "t", message: { content: "engineer typed this explanation" } }),
    { ts: "t", role: "user", text: "engineer typed this explanation" },
  );
  a.equal(PARSERS.engineer({ type: "assistant", message: { content: [{ type: "text", text: "assistant code answer" }] } }).text, "assistant code answer");
  a.equal(PARSERS.engineer({ type: "assistant", message: { content: '{"type":"text","text":"x"}' } }), null); // serialized dump
  a.equal(PARSERS.engineer({ type: "system" }), null);
});

test("parseFile: opt-out + tiny + non-json lines dropped; units carry stable ids", () => {
  const { units, lineCount } = parseFile(threadFile);
  a.equal(lineCount, 6);
  a.equal(units.length, 2); // real user msg + decision only
  a.ok(units.every((u) => u.text && !u.text.includes("do not index")));
  a.equal(units[0].role, "user");
  a.equal(units[0].line, 1);
  a.equal(units[1].role, "rin");
  a.equal(units[1].line, 6);
  a.match(units[0].id, /^[0-9a-f]{16}$/);
  a.equal(units[0].id, parseFile(threadFile).units[0].id); // deterministic across runs
});

test("parseFile incremental fromLine skips already-indexed lines", () => {
  const { units } = parseFile(threadFile, 3); // start at 0-based line index 3
  a.equal(units.length, 1);
  a.equal(units[0].line, 6);
  a.equal(units[0].role, "rin");
});

// ================================= redact.mjs ================================

test("redact: PEM private key block", () => {
  const pos = "-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEAAAAABG5vbmUAAA\n-----END OPENSSH PRIVATE KEY-----";
  const r = redact(pos);
  a.ok(r.text.includes("[REDACTED-PRIVATE-KEY]") && !r.text.includes("b3BlbnNz") && r.redacted >= 1);
  const neg = redact("We should keep the private key philosophy in mind.");
  a.ok(neg.redacted === 0 && neg.text === "We should keep the private key philosophy in mind.");
});

test("redact: GitHub PAT", () => {
  a.equal(redact("ghp_ABCDEFGHIJKLMNOPqrstuvwx0123456789").text, "[REDACTED-GH-TOKEN]");
  a.equal(redact("ghp_short").redacted, 0);
});

test("redact: openai-style key", () => {
  a.equal(redact("sk-ABCDEFGHIJKLMNOP0123").text, "[REDACTED-KEY]");
  a.equal(redact("sk-abc").redacted, 0);
});

test("redact: Slack token", () => {
  a.equal(redact("xoxb-123456789012-ABCdefGHIjklMNOpqr").text, "[REDACTED-SLACK]");
  a.equal(redact("xoxb-abc").redacted, 0);
});

test("redact: AWS access key id", () => {
  a.equal(redact("AKIAIOSFODNN7EXAMPLE").text, "[REDACTED-AWS]");
  a.equal(redact("AKIA123").redacted, 0);
});

test("redact: JWT", () => {
  const jwt = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c";
  const r = redact(jwt);
  a.ok(r.text.includes("[REDACTED-JWT]") && !r.text.includes("eyJhbGci") && r.redacted >= 1);
  a.equal(redact("eyJnope").redacted, 0);
});

test("redact: bearer token", () => {
  a.equal(redact("Bearer abcdefghijklmnopqrstuvwxyz012345").text, "bearer [REDACTED]");
  a.equal(redact("bearer ok").redacted, 0);
});

test("redact: key=secret assignment", () => {
  const r = redact('api_key = "supersecretvalue123"');
  a.equal(r.text, 'api_key = "[REDACTED]"');
  a.equal(redact("token = abc").redacted, 0); // value < 8 chars → left alone
});

test("redact: shape + no false positives on clean prose", () => {
  const input = "Hello world, this is a perfectly ordinary sentence.";
  const r = redact(input);
  a.ok(typeof r.text === "string" && typeof r.redacted === "number");
  a.ok(r.redacted === 0 && r.text === input);
});

// --- report -------------------------------------------------------------------
console.log(`\ntest-transcripts: ${passed} passed, ${failed} failed  (${passed + failed} tests, ${assertCount} assertions)`);
process.exit(failed ? 1 : 0);
