---
name: ui-council
description: Use when improving Verun's UI (sidebar, task board, or any screen) and you want an outside read on whether a change is actually better - captures the real app headlessly and has Claude and Codex judge blind, pairwise, against the baseline, looping until both prefer the candidate at 9/10.
---

# UI council

Hill-climb a UI change with a blind, multi-provider council. Adapted from Theo's
`council` skill (t3dotgg/tstack), corrected for the weak spots of absolute LLM scores:
judges compare **baseline vs candidate as anonymous A/B**, in random order per judge,
and the pairwise preference is the decision. Scores are recorded, not trusted alone.

## Pieces

- `uilab.html` + `src/uilab/main.ts` - the real app in a browser with mocked Tauri IPC
  over the demo seed (`src/lib/seedData.ts`). Extend the mocks there, never in product code.
- `shoot.mjs <outDir> [baseUrl]` - captures every scenario (main + board, dark + light).
- `judge.mjs <baselineDir> <candidateDir|-> <outDir>` - runs Claude (`claude -p`) and
  Codex (`codex exec -i`) read-only in parallel. `-` = critique-only mode for round 0.
- `rubric.md` - the factory-manager rubric. Edit it for non-sidebar/board work.

## Loop

1. Serve the candidate: `VITE_DEMO_MODE=true VITE_PORT=1527 VITE_HMR_PORT=1528 pnpm exec vite`
2. Serve the baseline from a detached worktree of the base commit (copy `uilab.html` and
   `src/uilab/` in if the base predates them, symlink `node_modules`), on port 1537.
3. Round 0: `shoot.mjs` the baseline, then `judge.mjs <base> - <out>` for a critique.
4. Change the code. Fix what **both** judges raise, plus anything that breaks the
   rubric's penalties. Refuse scope creep: a judge's idea is input, not a mandate.
5. `shoot.mjs` the candidate, `judge.mjs <base> <cand> <out>`. Read `verdict.json`.
6. Stop when `pass` is true (both prefer the candidate, both score it >= 9), after
   5 rounds, or after two rounds without gain. Then show the human before/after shots -
   the council advises, a person decides.

Keep TDD for any logic you touch (`pnpm test`), and check main + detached windows stay
in parity. Rounds live in the scratchpad, not the repo.

## Reporting

Put a "Council review" table in the PR: one row per judge, one column per round,
cell = preferred side and candidate score.
