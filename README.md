# roadmap-keeper

A Claude Code mod that keeps your projects' roadmaps current. After a commit, a pull request or a closed bead, it reminds the agent to update the roadmap page that the [`project-roadmap`](https://github.com/duysqubix/skills/tree/main/project-roadmap) skill made for that project. It speaks only while a roadmap is behind, and once for each new count.

- **Linking.** The mod keeps one list of roadmap pages. Each page covers a folder: the repo the agent was working in when it published the page. When the agent publishes a page with the `map` icon and a file name like `roadmap.html`, as the skill does, the mod adds it under the page's title. To add a page that already exists, or to move one to another folder, run `/roadmap link <claude.ai artifact URL> [folder] [title]`.
- **Title.** In a session with a name, set with `/rename` or `claude --name`, the mod gives the `project-roadmap` skill that name and asks the agent to use it, word for word, as the title of a new roadmap, and to keep the title of one that already exists. It is a request, not a rule: the list takes each page's title from the page the agent publishes. The title Claude Code makes up for an unnamed session doesn't count, so there the skill names the roadmap as usual.
- **Folders.** A milestone counts toward the roadmaps of the repo it ran in, wherever the session started. A session started in `~` that runs `git -C ~/app commit` or `cd ~/app && git commit` counts toward the roadmaps of `~/app`. When roadmap folders nest, the deepest one wins, and a repo inside another repo, such as a worktree or a submodule, counts toward the outer repo's roadmaps. A roadmap filed in no repo, such as `~`, counts only the work outside the repos under it, so a repo under it with no roadmap of its own counts toward none.
- **This session's roadmap.** A folder can have several roadmaps, one per effort. In each folder, a session works on one of them: the one it last published, wrote to through `ArtifactData` or linked, or the one picked with `/roadmap use <n>`. Its milestones there count toward that roadmap alone. Until it has one, they count toward all of the folder's roadmaps. A compaction or a fork keeps the picks; a new session, a resume and `/clear` start without them.
- **Milestones.** Each successful `git commit` (not `--amend`), `gh pr create`, `gh pr merge` and `bd close` counts. Quoted text and heredoc bodies don't, so a commit message or a grep pattern is no milestone. Success is the command's exit code, so a milestone piped into another command, as in `git commit … | tail -3`, counts even when it fails. A subagent's milestones count too.
- **The nudge.** After a milestone, the agent reads one line with the tool result: the roadmap's title and link, how far behind it is, and a cue to update it with the `project-roadmap` skill if the work finished a step or changed the plan. The nudge and the pointer below also ask for plain words: each thing named in words, not by a code like D1, an id or shorthand, since people read the page with no context. Before the session picks one of a folder's roadmaps, the line lists each one that is behind. The main agent hears about a subagent's milestones at its next tool call or prompt.
- **Pointer.** The first time the agent works in a roadmap's folder (a command there, or a file it reads or edits there), it reads that folder's roadmaps, which one this session works on, and when to update them. At startup, resume, `/clear` and compaction, it reads the pointer of the folder the session is in, so a long session doesn't lose it.
- **Status line.** It shows `roadmap: N behind` for this session's roadmap in the folder the agent last worked in, or for the furthest behind there when the session has none. A write to a page through `ArtifactData`, or a republish of it, resets that page's count.
- **Agents at work.** While a session works on a live roadmap, the page shows it: a ring and a name tag in the session's color on the step it works on. The mod writes one row per agent to the page's `agents` collection, and the page reads them live. The session's row is named for the roadmap's folder (`opentcg`, then `opentcg 2` for a second session) and takes the first of three colors no other session there holds. It sits at the step (or phase) the session last marked `active`, or at the You-are-here step. A helper (a subagent) gets a row named for its type, such as `code-reviewer`, in its parent's color; the loops Claude Code runs for itself get none. A row comes with a turn's first tool call and goes when the turn ends and no helper is still at work. The page hides a row not seen for 30 minutes, such as one a crash left behind. The session's roadmap is its roadmap in the folder the main agent last worked in, else where a helper last worked; while a folder's several roadmaps have no pick, the session has no row. A tool call that writes a row waits for it, a few tenths of a second and never more than ten. A failed row write (a page you can only view, plan mode, an interrupted call) pauses the rows until the next turn.
- **The mod's own OK.** Claude Code asks before a mod writes to an artifact's data. The mod approves its own writes to the `agents` collection of the pages in its list, so no prompt appears, and it refuses itself every other write. It never approves the model's writes or another mod's, nor overrides an ask that comes from your settings rules, a settings hook or another mod. Once it has approved one, Claude Code counts this mod's later writes in the session as approved, for this mod alone. Without the `ArtifactData` tool, as under `claude -p`, the rows try once a turn.

`/roadmap` lists every roadmap with its folder and count. `/roadmap link <url> [folder] [title]` adds a page, renames it or moves it. A folder starts with `/`, `~`, `./` or `../`; without one, a new page goes to the repo the session last worked in. `/roadmap use <n>` picks this session's roadmap in that roadmap's folder. `/roadmap unlink [n]` removes the roadmap numbered `n`; without a number, this session's roadmap in the folder it last worked in, or the only one.

The list lasts across sessions, and every session shares it, wherever it starts.

The mod finds a command's folder from where the Bash tool's last `cd` left the session, then from `cd`, `git -C`, `~`, `$HOME` and the variables the command sets before use (`R=~/app; git -C "$R" commit`). A subshell's `cd` ends with the subshell. A pipe's later stages, such as `| tail`, count with the stage before them, though a commit counts where it runs. A folder reached through a symbolic link counts as the folder it lands in, so `~/repos/app` counts as `~/.repos/app`. Files under `~/.claude`, such as skills, plugins and memory, are no project's work. The mod doesn't follow `pushd`, loops, or a `cd` inside an `if` or after `time`, so such a command counts where it started, and a `cd` in a nested subshell lasts until the outer one closes.

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

The test kit doesn't run a mod's `tool.check` hook on that mod's own calls, so the mod's own OK is checked live: run an ask-first session (`--permission-mode default`) on a throwaway linked page, and no prompt should appear for the rows. A mod call made after its hook returned skips every hook of the mod, that OK included, so each hook awaits its row writes.
