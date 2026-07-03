# Real datasets for the retrieval eval harness

The harness (`../run-eval.mjs`) reads **two files**:

- **dataset** — JSONL, one labeled query per line:
  ```json
  {"query": "where do code projects live?", "relevant": ["m03"]}
  ```
- **corpus** — JSONL, one memory per line (`id` is what `relevant` points at):
  ```json
  {"id": "m03", "text": "Code projects live under the Developer directory…", "type": "note", "date": "2026-06-02"}
  ```
  By default the runner looks for `<dataset-name>-corpus.jsonl` beside the dataset; override with `--corpus PATH`.

See `../fixtures/mini.jsonl` + `../fixtures/mini-corpus.jsonl` for a tiny working pair.

This doc shows how to turn a subset of two published long-term-memory QA benchmarks into that format.
**We do not download anything for you** — fetch the files yourself (they carry their own licenses), then run
the converters below. Both converters are pure Node (no deps, no model).

> **`relevant` = the gold evidence ids.** For retrieval metrics we ignore the free-text answer entirely and
> only score whether the engine surfaces the *evidence memories*. That's why no chat LLM is needed.

---

## 1. LoCoMo (turn-level evidence)

*"Evaluating Very Long-Term Conversational Memory of LLM Agents"*, Maharana et al., ACL 2024 (Snap Research).

| | |
|---|---|
| Repo | https://github.com/snap-research/locomo |
| Data file | `data/locomo10.json` — 10 long conversations (~2.8 MB) |
| Raw URL | https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json |
| License | **CC BY-NC 4.0** (`LICENSE.txt`) — ⚠ **non-commercial**. Fine for local before/after measurement; do **not** ship it or derived artifacts in a commercial product. |

Fetch it (example):

```bash
curl -L -o locomo10.json \
  https://raw.githubusercontent.com/snap-research/locomo/main/data/locomo10.json
```

**Schema** (top level is an array of conversations):

```jsonc
{
  "sample_id": "conv-26",
  "conversation": {
    "speaker_a": "Caroline", "speaker_b": "Melanie",
    "session_1_date_time": "1:56 pm on 8 May, 2023",
    "session_1": [ { "speaker": "Caroline", "dia_id": "D1:3", "text": "..." }, ... ],
    "session_2_date_time": "...", "session_2": [ ... ]
  },
  "qa": [
    { "question": "...", "answer": "...", "evidence": ["D1:3", "D4:3"], "category": 1 }
  ]
}
```

- **query** ← `qa.question`  **relevant** ← `qa.evidence` (list of `dia_id`s, format `D{session}:{turn}`).
- **corpus** ← every dialog turn (`dia_id` → `"speaker: text"`).
- `dia_id`s repeat across conversations, so we **namespace ids by `sample_id`** (`conv-26/D1:3`) to keep the
  pooled corpus collision-free. `category` 5 is adversarial/unanswerable (it still has an `evidence` field
  plus an `adversarial_answer`); we skip it — drop that `continue` if you want to keep it.

**Converter** — save as `locomo-to-eval.mjs`, then `node locomo-to-eval.mjs locomo10.json locomo`:

```js
import fs from "node:fs";
const [, , src, out = "locomo"] = process.argv;
const data = JSON.parse(fs.readFileSync(src, "utf8"));
const corpus = new Map(), queries = [];
for (const conv of data) {
  const ns = conv.sample_id, c = conv.conversation || {};
  for (const key of Object.keys(c)) {
    if (!/^session_\d+$/.test(key)) continue;              // skip *_date_time / speaker_*
    for (const t of c[key]) if (t && t.dia_id && t.text)
      corpus.set(`${ns}/${t.dia_id}`, `${t.speaker}: ${t.text}`);
  }
  for (const qa of conv.qa || []) {
    if (qa.category === 5) continue;                       // adversarial → skip (optional)
    const relevant = (qa.evidence || []).map((e) => `${ns}/${e}`);
    if (qa.question && relevant.length) queries.push({ query: qa.question, relevant });
  }
}
fs.writeFileSync(`${out}.jsonl`, queries.map((q) => JSON.stringify(q)).join("\n") + "\n");
fs.writeFileSync(`${out}-corpus.jsonl`,
  [...corpus].map(([id, text]) => JSON.stringify({ id, text })).join("\n") + "\n");
console.log(`${queries.length} queries, ${corpus.size} turns → ${out}.jsonl (+ -corpus.jsonl)`);
```

Run it:

```bash
node run-eval.mjs --dataset locomo.jsonl --k 5,10 --mode hybrid
# subset only? slice the source first: node -e 'const d=require("./locomo10.json");require("fs").writeFileSync("locomo2.json",JSON.stringify(d.slice(0,2)))'
```

---

## 2. LongMemEval (session-level evidence)

*"LongMemEval: Benchmarking Chat Assistants on Long-Term Interactive Memory"*, Wu et al., ICLR 2025.

| | |
|---|---|
| Repo | https://github.com/xiaowu0162/LongMemEval |
| Data (HF) | https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned |
| Files | `longmemeval_s_cleaned.json` (~115k-token haystacks, **real retrieval test**), `longmemeval_m_cleaned.json` (~500 sessions), `longmemeval_oracle.json` (evidence-only — note: no `_cleaned` suffix) |
| License | **MIT** |

⚠ Two footguns: use the **`-cleaned`** dataset id (the older `xiaowu0162/longmemeval` has files with **no `.json`
extension**), and don't grab `xiaowu0162/longmemeval-v2` — that's a *different* benchmark. Fetch via HF:

```bash
curl -L -o longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned/resolve/main/longmemeval_s_cleaned.json
```

> Prefer **`longmemeval_s_cleaned.json`** for a retrieval eval: it has many distractor sessions, so recall is
> meaningful. `longmemeval_oracle.json` contains *only* evidence sessions (no distractors) → recall is
> trivially ~1.0; use it only as a smoke test.

**Schema** (top level is an array of questions):

```jsonc
{
  "question_id": "...",
  "question_type": "single-session-user | multi-session | temporal-reasoning | knowledge-update | abstention | ...",
  "question": "...",
  "answer": "...",
  "haystack_session_ids": ["sess_1", "sess_2", ...],          // parallel to haystack_sessions
  "haystack_sessions":    [ [ {"role":"user","content":"..."},
                              {"role":"assistant","content":"...","has_answer":true} ], ... ],
  "answer_session_ids":   ["sess_2"]                          // ⇐ the relevant sessions
}
```

- **query** ← `question`  **relevant** ← `answer_session_ids` (subset of `haystack_session_ids`).
- **corpus** ← each session (`haystack_session_ids[i]` → its `haystack_sessions[i]` turns joined).
- Session ids can recur across questions with *different* haystacks, so we **namespace by `question_id`**.
- `abstention`-type questions have an empty `answer_session_ids` (no evidence) → skip them.
- Finer granularity: evidence turns carry `has_answer: true` (non-evidence turns may omit the key — test with
  `t.has_answer === true`). Swap the corpus id to `${qid}/${sid}#${turnIdx}` if you want turn-level eval.

**Converter** — save as `longmemeval-to-eval.mjs`, then `node longmemeval-to-eval.mjs longmemeval_s.json lme`:

```js
import fs from "node:fs";
const [, , src, out = "lme"] = process.argv;
const data = JSON.parse(fs.readFileSync(src, "utf8"));
const corpus = new Map(), queries = [];
for (const item of data) {
  const qid = item.question_id;
  const ids = item.haystack_session_ids || [], sessions = item.haystack_sessions || [];
  for (let i = 0; i < sessions.length; i++) {
    if (ids[i] == null) continue;
    const text = (sessions[i] || []).map((t) => `${t.role}: ${t.content}`).join("\n");
    corpus.set(`${qid}/${ids[i]}`, text);                     // namespaced → collision-free
  }
  const relevant = (item.answer_session_ids || []).map((s) => `${qid}/${s}`);
  if (item.question && relevant.length) queries.push({ query: item.question, relevant });  // skips abstention
}
fs.writeFileSync(`${out}.jsonl`, queries.map((q) => JSON.stringify(q)).join("\n") + "\n");
fs.writeFileSync(`${out}-corpus.jsonl`,
  [...corpus].map(([id, text]) => JSON.stringify({ id, text })).join("\n") + "\n");
console.log(`${queries.length} queries, ${corpus.size} sessions → ${out}.jsonl (+ -corpus.jsonl)`);
```

Run it (slice a subset first if the full haystack is large):

```bash
node -e 'const d=require("./longmemeval_s.json");require("fs").writeFileSync("lme50.json",JSON.stringify(d.slice(0,50)))'
node longmemeval-to-eval.mjs lme50.json lme50
node run-eval.mjs --dataset lme50.jsonl --k 5,10 --mode hybrid
```

---

## Notes

- **Model needed for real corpora.** `--mode hybrid`/`semantic` embed the corpus with arctic-embed; if the GGUF
  is absent the runner prints how to get it and exits cleanly. `--mode keyword` needs no model (good for a quick
  structural check that your converted files parse and score).
- **A/B a change** (decay / reranker) on a converted set exactly like the fixture, e.g.
  `node run-eval.mjs --dataset lme50.jsonl --ab rerank --rerank`.
- **Reconciliation / links** change the *corpus itself*, not the ranker — evaluate those by regenerating the
  corpus before vs. after and diffing two `--out` reports over the same dataset.
- Keep converted files out of the repo (they're big and, for LoCoMo, non-commercial) — drop them somewhere like
  `eval/datasets/local/` and pass explicit `--dataset` / `--corpus` paths.
