# Changelog — connection-synthesis

## 1.0.0 (2026-06-17)
- Initial release. Packages Rin's live connection-synthesis capability (18 dogfood connection notes in
  `memory/05-connections/`) as a clean, standalone skill.
- `scripts/find-connections.sh` — surfaces candidate cross-domain connections for a seed via semantic
  search (`msem`), bucketed by domain, with a synthesis prompt for the agent.
- `references/synthesis-guide.md` — the method: type-based capture, cross-domain pull, real insight vs
  restatement, the connections store, and cadence.
- Derived from the `connection-synthesis` Runbook book. The authoritative contract is SKILL.md.
