# roadmap-keeper

A Claude Code mod that keeps a project's roadmaps current. After a commit, a pull request or a closed bead, it reminds the agent to update the roadmap page that the [`project-roadmap`](https://github.com/duysqubix/skills/tree/main/project-roadmap) skill makes. It speaks only while a roadmap is behind, and once for each new count.

- **Linking.** The mod keeps a list of roadmap pages for the folder Claude Code started in, one per effort. When the agent publishes a page with the `map` icon and a file name like `roadmap.html`, as the skill does, the mod adds it to the list under the page's title. To add a page that already exists, run `/roadmap link <claude.ai artifact URL> [title]`.
- **This session's roadmap.** Each session works on one roadmap: the one it last published, wrote to through `ArtifactData` or linked, or the one picked with `/roadmap use <n>`. Its milestones count toward that roadmap alone. Until a session has one, its milestones count toward all of them. A compaction or a fork keeps the pick; a new session, a resume and `/clear` start without one.
- **Milestones.** Each successful `git commit` (not `--amend`), `gh pr create`, `gh pr merge` and `bd close` counts. Quoted text and heredoc bodies don't, so a commit message or a grep pattern is no milestone. A subagent's milestones count too.
- **The nudge.** After a milestone, the agent reads one line with the tool result: the roadmap's title and link, how far behind it is, and a cue to update it with the `project-roadmap` skill if the work finished a step or changed the plan. Before the session has a roadmap, the line lists each one that is behind. The main agent hears about a subagent's milestones at its next tool call or prompt.
- **Status line.** It shows `roadmap: N behind` for this session's roadmap, or for the furthest behind when the session has none. A write to a page through `ArtifactData`, or a republish of it, resets that page's count.
- **Pointer.** At startup, resume, `/clear` and compaction, the agent reads the folder's roadmaps, which one this session works on, and when to update them, so a long session doesn't lose them.

`/roadmap` lists the roadmaps and their counts. `/roadmap link <url> [title]` adds a page or renames one. `/roadmap use <n>` picks this session's roadmap. `/roadmap unlink [n]` removes the roadmap numbered `n`; without a number, this session's roadmap or the only one.

The list lasts across sessions. Sessions started in the same folder share it, and each picks its own roadmap.

The skill builds `roadmap.html` each time, and within one conversation a publish of the same file replaces the page it made before. To start a second effort's roadmap in the same conversation, ask for another file name, such as `kitchen-roadmap.html`.

## Install

At the prompt of a terminal session:

```
/plugin install roadmap-keeper --marketplace duysqubix/roadmap-keeper
```

Answer `y` to add the marketplace, then press Enter for the user scope.

From a shell:

```
claude plugin install roadmap-keeper --marketplace duysqubix/roadmap-keeper
```

In the desktop app, where `/plugin` does not run: click + next to the prompt box, then Plugins, Add marketplace with `duysqubix/roadmap-keeper`, then Add plugin.

The nudge points the agent at the `project-roadmap` skill, which makes and updates the page. The skill ships in [duysqubix/skills](https://github.com/duysqubix/skills).

## Updates

Every commit on `main` is a release. `plugin.json` has no `version`, so Claude Code versions the plugin by commit.

Claude Code leaves auto-update off for marketplaces it does not ship. To turn it on, set `autoUpdate` on the marketplace's entry in `~/.claude/settings.json`. Claude Code ignores this flag in project and local settings.

```json
"extraKnownMarketplaces": {
  "roadmap-keeper": {
    "source": { "source": "github", "repo": "duysqubix/roadmap-keeper" },
    "autoUpdate": true
  }
}
```

Each session then checks for new commits at a random moment in its first 10 minutes. To update right away, run this from a shell, then `/reload-plugins` in each session that is already open:

```
claude plugin marketplace update roadmap-keeper && claude plugin update roadmap-keeper@roadmap-keeper
```

## Develop

From your clone:

```
claude --plugin-dir .   # this folder overrides the installed copy and reloads after each edit
```

A push to `main` is a release, so run the checks before you push:

```
claude plugin validate . && claude plugin test . && tsc -p .
```

`tsc` needs the types the engine writes into `.claude-plugin/types/` the first time a `--plugin-dir` session loads the folder.
