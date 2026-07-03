#!/bin/bash
# ============================================================================
#  cognitive-memory — standalone store bootstrap (NUMBERED layout)
#  Usage: bash init_memory.sh /path/to/workspace
#
#  ⚠️  WHICH ONE WINS?
#  The Memory Suite's top-level  install.sh  is the CANONICAL installer: it
#  creates this exact numbered store AND installs the semantic stack
#  (msem/mdeep + the local embedding model) that recall depends on.
#  Prefer install.sh for the full suite.
#
#  This script is the SKILL-ONLY bootstrap — it lays down just the numbered
#  memory store + templates + git audit, for when you're installing the
#  cognitive-memory skill on its own (no semantic stack / no model). Both
#  produce the IDENTICAL store shape below, so they never drift.
#
#  Numbered layout (the shape every Memory-Suite skill reads/writes):
#     memory/00-core 01-episodic
#            02-semantic/{patterns,questions,numbers,distilled}
#            03-procedural 04-meta 05-connections  + .semantic/transcripts
# ============================================================================
set -e

WORKSPACE="${1:-.}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SKILL_DIR="$(dirname "$SCRIPT_DIR")"
TEMPLATES="$SKILL_DIR/assets/templates"

echo "🧠 Initializing cognitive memory store (numbered layout) in: $WORKSPACE"

# --- Create the numbered directory structure (matches install.sh) ---
echo "📁 Creating directory structure..."
mkdir -p "$WORKSPACE/memory/00-core"
mkdir -p "$WORKSPACE/memory/01-episodic"
mkdir -p "$WORKSPACE/memory/02-semantic/patterns"
mkdir -p "$WORKSPACE/memory/02-semantic/questions"
mkdir -p "$WORKSPACE/memory/02-semantic/numbers"
mkdir -p "$WORKSPACE/memory/02-semantic/distilled"
mkdir -p "$WORKSPACE/memory/03-procedural"
mkdir -p "$WORKSPACE/memory/04-meta"
mkdir -p "$WORKSPACE/memory/04-meta/reflections"
mkdir -p "$WORKSPACE/memory/04-meta/reflections/dialogues"
mkdir -p "$WORKSPACE/memory/04-meta/rewards"
mkdir -p "$WORKSPACE/memory/05-connections"
mkdir -p "$WORKSPACE/memory/.semantic/transcripts"

# --- Copy core templates (workspace-root, layout-agnostic) ---
echo "📋 Copying templates..."

# Core memory
if [ ! -f "$WORKSPACE/MEMORY.md" ]; then
    cp "$TEMPLATES/MEMORY.md" "$WORKSPACE/MEMORY.md"
    echo "   ✅ Created MEMORY.md"
else
    echo "   ⏭️  MEMORY.md already exists, skipping"
fi

# Identity
if [ ! -f "$WORKSPACE/IDENTITY.md" ]; then
    cp "$TEMPLATES/IDENTITY.md" "$WORKSPACE/IDENTITY.md"
    echo "   ✅ Created IDENTITY.md"
else
    echo "   ⏭️  IDENTITY.md already exists, skipping"
fi

# Soul
if [ ! -f "$WORKSPACE/SOUL.md" ]; then
    cp "$TEMPLATES/SOUL.md" "$WORKSPACE/SOUL.md"
    echo "   ✅ Created SOUL.md"
else
    echo "   ⏭️  SOUL.md already exists, skipping"
fi

# Semantic-store seeds (knowledge graph index + relations live under 02-semantic/)
if [ ! -f "$WORKSPACE/memory/02-semantic/index.md" ]; then
    cp "$TEMPLATES/graph-index.md" "$WORKSPACE/memory/02-semantic/index.md"
    echo "   ✅ Created 02-semantic/index.md"
fi

if [ ! -f "$WORKSPACE/memory/02-semantic/relations.md" ]; then
    cp "$TEMPLATES/relations.md" "$WORKSPACE/memory/02-semantic/relations.md"
    echo "   ✅ Created 02-semantic/relations.md"
fi

# Meta files (system-about-memory) live under 04-meta/
if [ ! -f "$WORKSPACE/memory/04-meta/decay-scores.json" ]; then
    cp "$TEMPLATES/decay-scores.json" "$WORKSPACE/memory/04-meta/decay-scores.json"
    echo "   ✅ Created 04-meta/decay-scores.json"
fi

if [ ! -f "$WORKSPACE/memory/04-meta/reflection-log.md" ]; then
    cp "$TEMPLATES/reflection-log.md" "$WORKSPACE/memory/04-meta/reflection-log.md"
    echo "   ✅ Created 04-meta/reflection-log.md"
fi

if [ ! -f "$WORKSPACE/memory/04-meta/reward-log.md" ]; then
    cp "$TEMPLATES/reward-log.md" "$WORKSPACE/memory/04-meta/reward-log.md"
    echo "   ✅ Created 04-meta/reward-log.md"
fi

if [ ! -f "$WORKSPACE/memory/04-meta/audit.log" ]; then
    printf '%s\n' "# Audit Log — Cognitive Memory System" \
                  "# Format: TIMESTAMP | ACTION | FILE | ACTOR | APPROVAL | SUMMARY" \
                  "" > "$WORKSPACE/memory/04-meta/audit.log"
    echo "   ✅ Created 04-meta/audit.log"
fi

if [ ! -f "$WORKSPACE/memory/04-meta/pending-memories.md" ]; then
    cp "$TEMPLATES/pending-memories.md" "$WORKSPACE/memory/04-meta/pending-memories.md"
    echo "   ✅ Created 04-meta/pending-memories.md"
fi

if [ ! -f "$WORKSPACE/memory/04-meta/evolution.md" ]; then
    cp "$TEMPLATES/evolution.md" "$WORKSPACE/memory/04-meta/evolution.md"
    echo "   ✅ Created 04-meta/evolution.md"
fi

if [ ! -f "$WORKSPACE/memory/04-meta/pending-reflection.md" ]; then
    cp "$TEMPLATES/pending-reflection.md" "$WORKSPACE/memory/04-meta/pending-reflection.md"
    echo "   ✅ Created 04-meta/pending-reflection.md"
fi

# --- Initialize git (audit ground truth) ---
echo "🔍 Setting up git audit tracking..."
cd "$WORKSPACE"

if [ ! -d ".git" ]; then
    git init -q
    git add -A
    git commit -q -m "[INIT] Cognitive memory system initialized

Actor: system:init
Approval: auto
Trigger: init_memory.sh"
    echo "   ✅ Git repository initialized"
else
    echo "   ⏭️  Git repository already exists"
fi

# --- Summary ---
echo ""
echo "✅ Cognitive memory store initialized (numbered layout)!"
echo ""
echo "Directory structure:"
echo "  $WORKSPACE/"
echo "  ├── MEMORY.md                          (core memory)"
echo "  ├── IDENTITY.md                        (facts + self-image)"
echo "  ├── SOUL.md                            (values, principles)"
echo "  ├── memory/"
echo "  │   ├── 00-core/                       (facts that never decay)"
echo "  │   ├── 01-episodic/                   (daily logs)"
echo "  │   ├── 02-semantic/                   (knowledge)"
echo "  │   │   ├── patterns/  questions/  numbers/"
echo "  │   │   ├── distilled/                 (smart-distill output)"
echo "  │   │   ├── index.md                   (graph topology)"
echo "  │   │   └── relations.md               (edge vocabulary)"
echo "  │   ├── 03-procedural/                 (learned workflows)"
echo "  │   ├── 04-meta/                       (memory about memory)"
echo "  │   │   ├── decay-scores.json  reflection-log.md  reward-log.md"
echo "  │   │   ├── evolution.md  audit.log  pending-*.md"
echo "  │   │   └── reflections/  rewards/"
echo "  │   ├── 05-connections/                (synthesized cross-note insight)"
echo "  │   └── .semantic/transcripts/         (deep-recall transcript shards)"
echo "  └── .git/                              (audit ground truth)"
echo ""
echo "Next steps:"
echo "  1. For full recall (msem/mdeep), run the suite's  install.sh  to add the"
echo "     semantic stack + embedding model, then:  node scripts/semantic/index.mjs"
echo "  2. Append assets/templates/agents-memory-block.md to AGENTS.md"
echo "  3. Customize IDENTITY.md and SOUL.md for your agent"
echo "  4. Test: 'Remember that I prefer dark mode.'"
