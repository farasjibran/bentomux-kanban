# Bentomux Kanban

A task board plugin for [Bentomux](https://github.com/takora-dev/bentomux), the
calm desktop for AI agent runtime workspaces.

| Plugin | What it does |
|---|---|
| [farrasjibran.kanban](farrasjibran.kanban/) | A Jira-style board: add tasks, drag them between To Do, In Progress and Done |

## Install

Settings → Plugins → **Install plugin…** → *A plugin package (.zip)*, and pick
the `.zip` from this repository's releases. Its files sit at the archive root,
which is what that installer expects.

Installing from a folder works too: point the folder option at
`farrasjibran.kanban/`.

## Install from the marketplace

Settings → Plugins → **Browse marketplace…** — this repository carries the
`bentomux-plugin` topic, which is how the sweep finds it. An update is offered
by comparing the release tag with the manifest version, so the two have to
agree; `publish.sh` refuses to publish when they do not.

## Publishing a new version

```bash
./publish.sh <version>
```

Bump `version` in `farrasjibran.kanban/plugin.json` first. The script validates
the plugin, refuses to publish a version that disagrees with the manifest, and
builds `.build/farrasjibran.kanban-<version>.zip` with `plugin.json` at the
archive root. It then creates the GitHub release with `gh`, which is what makes
GitHub publish the sha256 the app verifies a download against.

## License

MIT

