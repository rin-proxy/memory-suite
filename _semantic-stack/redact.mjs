// redact.mjs — replace obvious secrets with [REDACTED] before embedding/storing. PURE.
// Targeted (known-shaped) rules — over-redaction beats leaking, but avoid nuking legit prose/code.
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
