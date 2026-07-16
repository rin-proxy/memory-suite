// redact.mjs — replace obvious secrets with [REDACTED] before embedding/storing. PURE.
// Targeted (known-shaped) rules — over-redaction beats leaking, but avoid nuking legit prose/code.
import { pathToFileURL } from "node:url";
const RULES = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, "[REDACTED-PRIVATE-KEY]"],
  [/\bgh[posru]_[A-Za-z0-9]{20,}\b/g, "[REDACTED-GH-TOKEN]"],                          // github PAT
  [/\b(?:sk|pk|rk)-[A-Za-z0-9]{16,}\b/g, "[REDACTED-KEY]"],                            // openai-ish
  [/\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, "[REDACTED-SLACK]"],
  [/\bAKIA[0-9A-Z]{16}\b/g, "[REDACTED-AWS]"],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED-JWT]"],
  [/\bbearer\s+[A-Za-z0-9._~+/-]{20,}=*/gi, "bearer [REDACTED]"],
  [/((?:api[_-]?key|secret|token|password|passwd|pwd|access[_-]?token|auth[_-]?token|client[_-]?secret)\s*[=:]\s*["']?)([^\s"',;]{8,})/gi, "$1[REDACTED]"],
];

export function redact(text) {
  let out = text, redacted = 0;
  for (const [re, rep] of RULES) {
    out = out.replace(re, (m, g1) => { redacted++; return rep.includes("$1") ? rep.replace("$1", g1 ?? "") : rep; });
  }
  return { text: out, redacted };
}

// CLI: `node redact.mjs < input > redacted`  — best-effort secret stripping for the CURATED save/distill
// paths (save.sh, distill-store.sh), which persist agent-judged notes that can legitimately mention creds.
// redact() above stays PURE; this block only runs when the file is executed directly, never on import.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let input = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (d) => (input += d));
  process.stdin.on("end", () => {
    const { text, redacted } = redact(input);
    process.stdout.write(text);
    if (redacted > 0) process.stderr.write(`redact: ${redacted} secret(s) stripped before store\n`);
  });
}
