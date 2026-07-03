# Changelog — cognitive-memory

## 1.2.2 (2026-07-02)
- **Real retrieval-time decay signal.** The advertised "human-like decay" is now actually wired into recall instead of shipping an empty, unread `decay-scores.json`. After RRF fusion, `msem`/`mdeep` multiply each hit's fused score by a bounded decay factor `clamp(recencyBoost × accessBoost × importanceWeight, 0.3, 1.5)` from `memory/.semantic/decay-scores.json` (recency half-life ~30 d, staleness half-life ~180 d, access slope 0.15·log2, importance default 0.5⇒1.0). Recently/often-recalled notes float up; long-unused ones sink toward the 0.3 floor.
- **Living signal.** Each search bumps `access` and `lastAccessMs` for the files it returned and persists atomically — best-effort behind a concurrent-writer lock, so a failed/contended score write never fails or slows a search.
- **Backward-compatible by contract.** Absent / empty / corrupt `decay-scores.json` ⇒ every factor is exactly 1.0 ⇒ ranking is byte-identical to 1.2.1. RRF is unchanged; decay is a post-fusion multiplier only.
- Shared `writeJsonAtomic` + workspace path lifted into `scripts/semantic/store.mjs` (model-free) and reused by `index.mjs` and the new `decay.mjs`; added `test-decay.mjs` (pure Node, no model/network). Honesty pass on `SKILL.md` + `references/operations.md` to describe the mechanism that actually ships.

## 1.2.1 (2026-07-02)
- Portability + integrity hardening for clean-machine installs on Linux **and** macOS/BSD.
- Suite install.sh: portable `sha256` helper (`sha256sum` or `shasum`); native build-toolchain preflight (compiler/make/python3) before the node-llama-cpp compile; the embedding model's sha256 is now pinned and **verified — the install aborts on mismatch or a blank pin**.
- Shell scripts shimmed for BSD tools: `stat -f` mtime fallback (proactive-scan), `free` guarded (morning-briefing), portable `sha256` (smart-distill).
- Added `PORTABILITY.md`; seed companion flat-files so morning-briefing / proactive-partner don't false-alarm on a fresh install. Version metadata realigned to 1.2.1.

## 1.2.0 (2026-06-15)
- Packaging pass: README added, frontmatter standardized (license / lastUpdated), structure/PDA hygiene.
- Baseline entry — track future changes here going forward. The authoritative contract is SKILL.md.
