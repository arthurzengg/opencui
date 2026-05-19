# opencui agent pack

Three custom opencode agents tuned for the OpenCode Panel sidebar (narrow column, Review Changes panel, `@file` chips, paperclip attachments). Drop them into your opencode agent directory and they'll appear in the agent picker.

| Agent | When to pick it | What it's tuned for |
|---|---|---|
| **scout** | "Where is X?" / "Who calls Y?" / "How does Z work?" | Read-only exploration. ≤5 bullets per answer, `@file:line` refs auto-chip-rendered, no XML envelopes, no wide tables. |
| **crafter** | Targeted bug fix, rename, single-file refactor | One scope per turn → one Review Changes card. Prefers `edit` over `write`. Hands off explicitly when scope is too big. |
| **lens** | You attached a screenshot, mockup, error screen, or PDF | Two-section output (What I see / Action). No padding prose. Points at `@file` for fixes. |

## Install

Pick the scope you want:

```bash
# Project-local (only this repo)
mkdir -p .opencode/agent && cp agents/*.md .opencode/agent/

# User-global (every project)
mkdir -p ~/.config/opencode/agent && cp agents/*.md ~/.config/opencode/agent/
```

Then **restart the opencode server** (in opencui: `OpenCode Panel: Restart Backend` from the command palette, or just reload the VS Code window). The agents are loaded at server start — there's no hot-reload.

Verify the install:

```bash
ls ~/.config/opencode/agent/    # should show scout.md, crafter.md, lens.md
```

In the opencui chat, click the agent picker — `scout`, `crafter`, and `lens` should appear alongside `build` and `plan`.

## Why these three (and not 10)

opencode already ships `build` (default), `plan` (read-only architecture), and `explore` (subagent for codebase search). The three agents above don't replace them — they're sidebar-optimized variants:

- **`scout` vs `explore`**: `explore` is a subagent (only invokable via the `task` tool); `scout` is `primary` (selectable directly). `explore` also emits absolute paths in a verbose format that wraps awkwardly in narrow columns. `scout` caps output at 5 bullets and uses opencui's `@file` chip syntax.
- **`crafter` vs `build`**: `build` is general-purpose; `crafter` enforces one-scope-per-turn so the Review Changes panel stays scannable. Multi-file logical units (a rename across 3 callsites) are allowed; "while I'm here, let me also…" isn't.
- **`lens`** has no stock counterpart. opencode handles attachments via `FilePart`, but the default `build` prompt doesn't know that "the user attached an image" is a special interaction shape. `lens` assumes a paperclip flow and outputs a strict two-section format.

## Notes

- All three agents avoid emitting `<analysis>` / `<results>` / other XML wrappers. If you're also using **oh-my-openagent**, opencui v0.7.x+ renders those wrappers as bold-labelled markdown sections via its built-in pre-processor — so the explore-XML envelope will look fine in the sidebar too.
- None of these agents pin a model. They flow through whatever you've selected in the picker. If you want a per-agent default, add `model: provider/model-id` to the frontmatter.
- All three agents disable `todowrite`. The sidebar shows todos in a side block that's nice for long plans but redundant for the short, focused turns these agents emit.
- The `permission` keys use `allow|ask|deny` strings (not booleans). Booleans crash opencode at startup ([sst/opencode#7810](https://github.com/sst/opencode/issues/7810)).
