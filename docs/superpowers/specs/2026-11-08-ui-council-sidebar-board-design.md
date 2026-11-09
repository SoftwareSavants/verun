# UI council: sidebar + board hill climb

## Intent

Verun is becoming a software factory and the user is its factory manager. The manager's
core question, asked dozens of times a day, is: **what needs me, what is still working,
and what is done?** The sidebar and the task board are where that question lives. Today
neither answers it at a glance: power users work around the sidebar by opening tasks in
separate windows just to see what's running.

We improve these two surfaces with a repeatable, agent-driven loop (inspired by Theo's
`council` skill in t3dotgg/tstack), corrected for the weaknesses of absolute LLM scoring.

## Goals

- Sidebar answers "what needs me / running / done" in under 3 seconds for a normal user
  (a couple of projects, 3-10 live tasks), and stays legible at 30 tasks.
- Board becomes the manager's floor view: triage first, scannable cards, no wasted chrome.
- A reusable `ui-council` project skill: headless screenshots of the real app + blind
  pairwise judging by Claude and Codex, so any future UI work can be climbed the same way.

## Non-goals

- New backend state or IPC. Everything uses existing task/session/git signals.
- Changing task semantics or the detached-window feature. (Board grouping did change: both
  judges independently asked to split Ready, and PRODUCT.md already says idle is not done.)
- Redesigning the chat view, changes panel, or settings in this pass.

## Anti-goals (failure even if judges score it 9/10)

- Generic "AI look": gradients, glows, glassmorphism, oversized cards, decoration.
- Status communicated by color alone.
- Lower density. Verun is a compact, quiet desktop tool (see DESIGN.md, PRODUCT.md).
- Any regression of keyboard access (Cmd+1..9, focus rings) or context menus.
- Main window and detached task window drifting apart.

## Method (decided)

1. **UI lab harness** (`uilab.html`, `src/uilab/main.ts`): renders the real app in a
   browser with mocked Tauri IPC over the existing demo seed data (`VITE_DEMO_MODE`).
   Dev-only; not part of the production build input.
2. **Scenarios**: main view (sidebar) and board view, dark and light, 1440x900.
3. **Judges**: Claude (`claude -p`, reads images) and Codex (`codex exec -i`), read-only.
   Two providers is what we have; a third can be added later without changing the flow.
4. **Blind pairwise**: each round, judges see baseline and candidate as "A"/"B" in random
   order per judge, pick which they'd ship, list problems in each, and give each a 1-10.
   Scores are tracked for the record; the **decision is the pairwise preference**.
5. **Rubric** (in judge prompt): triage at a glance, status legibility without color,
   scale to 30 tasks, hierarchy/density, craft, consistency with DESIGN.md.
6. **Loop**: fix only issues both judges raise or that violate the anti-goals; scope
   creep is refused. Stop when both judges prefer the candidate and score it >= 9, or
   after 5 rounds, or when two rounds show no gain.
7. **Human gate**: final before/after screenshots go to the user. Judges don't merge.

## Outcome (3 rounds)

| Judge  | Round 1        | Round 2        | Round 3        |
|--------|----------------|----------------|----------------|
| Claude | candidate, 7/4 | candidate, 7/4 | candidate, 7/3 |
| Codex  | candidate, 8/5 | candidate, 8/5 | candidate, 8/5 |

Cell: preferred side, candidate score / baseline score. Both judges preferred the candidate
every round at confidence 5/5. Scores plateaued and judges began reversing earlier asks
(queue cap, title wrapping), so the stop rule ended the climb before 9/10 and the final
calls were made by the product owner: the Needs-you queue is never truncated.

## Builder's latitude

Exact visual design of status, grouping, and cards is the climb's output. Constraints:
existing UnoCSS tokens, lucide icons, `<For>`, ring utilities, existing tests stay green
(update tests only where the markup contract intentionally changed, TDD for new logic).
