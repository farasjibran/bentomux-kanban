# Kanban

A task board for [Bentomux](https://github.com/takora-dev/bentomux): add tasks,
drag them between columns, done.

| File | Purpose |
|---|---|
| `plugin.json` | The manifest: identity, permissions, contributions. |
| `index.js` | The entry point. Bentomux imports it and calls `activate(ctx)`. |
| `index.test.mjs` | The check for the board maths. |
| `bentomux-plugin-sdk.d.ts` | Types for the context API. |

## Using it

**Kanban** in the sidebar, or *Kanban: Open the board* in the command palette.
The board opens as a workspace tab, and only when asked for.

- **Add** — `+ Add task` in a column. Enter keeps the composer open, so a stack
  of tasks goes in without touching the mouse again.
- **Move** — drag a card anywhere in a column, or between two cards to pick its
  slot; a ghost follows the pointer and Escape cancels the drag. On a focused
  card, Alt+Left/Right changes column and Alt+Up/Down reorders.
- **Rename** — double-click the title (Enter saves, Escape cancels).
- **Priority** — click the chip; it cycles none, low, medium, high.
- **Links** — a URL in a title is underlined, and clicking it opens your
  default browser. `https://…` and a bare `www.…` both count; Enter opens a
  focused link.
- **Delete** — the x on the card.

## On launch

The plugin declares a service, so Bentomux loads it at startup instead of on
first click and it waits in the background. It never opens its own tab: the
board appears when you click the sidebar entry or the palette command.

Tasks are Plugin Data (`ctx.storage`), so the board survives restarts and
uninstalling the plugin keeps it.

## The check

```bash
node index.test.mjs
```

Covers `place()` and `dropIndex()` — the column ordering and drop-slot maths.

A type pass over the entry catches a mistyped identifier before the tab ever
renders — a plugin tab reports that failure as "failed to render":

```bash
npx tsc --noEmit --ignoreConfig --allowJs --checkJs --strict false \
  --noImplicitAny false --target es2022 --lib es2022,dom index.js
```

## Validating

```bash
bentomux --plugin-validate .
```

Reference: `docs/PLUGIN_PLATFORM.md` in the Bentomux repository.

