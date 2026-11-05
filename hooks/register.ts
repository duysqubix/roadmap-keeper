import type { EngineInterface, Register, ToolCallInput } from 'claude-code'

// Every folder's roadmaps, kept across sessions in $.store under `roadmaps`. Each covers a folder, `dir`: the repo the
// agent last worked in when it was published, or the folder /roadmap link names. A milestone (a commit, a PR, a closed
// bead) counts toward the roadmaps of the repo it ran in, wherever the session started: those of the deepest roadmap
// folder that holds the folder it ran in (`at` says which). `behind` counts them since the roadmap's last write. In each
// folder a session works on one roadmap, its pick there: the one it last published, wrote to, linked or picked. Until
// it has one, its milestones there count toward all of them.
// ponytail: the picks live in this module, so a plugin reload drops them until the next write; move them to $.state if that bites.
// ponytail: each hook saves the whole list it loaded, so overlapping hooks (parallel calls, two sessions) can lose
// a count or a sync; keep each count under its own key if that bites.
type Roadmap = { url: string; title?: string; behind: number; dir: string }

const KEY = 'roadmaps'
const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/
const MILESTONE =
  /\bgit\b[^;&|\n]*\scommit\b(?![^;&|\n]*\s--amend\b)|\bgh\b[^;&|\n]*\spr\s+(?:create|merge)\b|\bbd\s+close\b/
const WRITES = ['set', 'update', 'delete', 'str_replace', 'batch']
const HEREDOC = /<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g
const QUOTED = /"(?:\\.|[^"\\])*"|'[^']*'/g
// The parts of a shell command between `;`, `&`, `|` and line breaks, and the words of a part. Quoted text stays
// whole, and so does a redirection such as `2>&1` or `&>log`.
const PART = /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[<>]&|&>|[^;&|\n"'\\])+/g
const WORD = /(?:"(?:\\.|[^"\\])*"|'[^']*'|\\.|[^\s"'\\])+/g

let home = ''
let folder = '' // where the session started, which the earlier versions kept their lists under
let here: string | undefined // the roadmap folder the main loop last worked in
const picks = new Map<string, string>() // per roadmap folder, the url of this session's roadmap there
const heard = new Map<string, number>() // per url, the `behind` count the main loop last heard about
const raised = new Set<string>() // the urls this session's milestones counted toward
const told = new Set<string>() // the roadmap folders whose pointer the agent has in its context
const recent: string[] = [] // the folders this session's tool calls touched lately, newest last, as written

const urlIn = (text?: string) => text?.match(ARTIFACT_URL)?.[0]
// The command without heredoc bodies and quoted text, so a commit message or a grep pattern is no milestone.
const bare = (command: string) => command.replace(HEREDOC, '').replace(QUOTED, '""')
// `path` from `base`, with `~`, `.` and `..` resolved.
const resolve = (base: string, path: string) => {
  const p = path.replace(/^~(?=\/|$)/, home)
  const out: string[] = []
  for (const s of (p.startsWith('/') ? p : `${base}/${p}`).split('/'))
    if (s === '..') out.pop()
    else if (s && s !== '.') out.push(s)
  return `/${out.join('/')}`
}
const inside = (path: string, dir: string) => path === dir || path.startsWith(dir === '/' ? dir : `${dir}/`)
const short = (dir: string) => (home && inside(dir, home) ? `~${dir.slice(home.length)}` : dir)

// The folders a shell command's parts ran in, and those its milestones ran in. A part runs where the `cd`s before it
// left, or where its `-C` points, and a subshell's `cd`s end with it. A pipe's later stages count with the stage before
// them, though a milestone counts where it runs. `~`, `$HOME` and the variables the command set before are expanded.
// ponytail: a nested subshell's `cd` lasts until the outer one closes. Loops, pushd, and a `cd` or `(` after `then`,
// `else`, `time` or `!` aren't followed. Where a path can't be told, the part counts where it started.
const foldersOf = (command: string, cwd: string) => {
  const vars: Record<string, string> = { HOME: home }
  const expand = (word: string) =>
    word
      .replace(QUOTED, q => q.slice(1, -1))
      .replace(/\$(?:\{(\w+)\}|(\w+))/g, (m, a?: string, b?: string) => vars[a ?? b ?? ''] ?? m)
  const to = (word: string | undefined, base: string) => {
    const path = word === undefined ? '~' : expand(word)
    return path.includes('$') ? base : resolve(base, path)
  }
  const text = command.replace(HEREDOC, '').replace(/\\\n/g, ' ') // a line ending in `\` goes on
  let dir = cwd
  let last = cwd // where the part before counts
  let outer: string | undefined // where the open subshell started
  let depth = 0 // its brackets still open
  const all = new Set<string>()
  const milestones = new Set<string>()
  for (const m of text.matchAll(PART)) {
    const part = m[0]
    if (outer === undefined && /^\s*\(/.test(part)) [outer, depth] = [dir, 0]
    const code = part.replace(QUOTED, '""')
    depth += (code.match(/\(/g) ?? []).length - (code.match(/\)/g) ?? []).length
    const words: string[] = part.replace(/^\s*[({]/, '').match(WORD) ?? []
    if (words[0] === 'export') words.shift()
    for (let w = words[0]; w !== undefined && /^\w+=/.test(w); w = words[0]) {
      words.shift()
      vars[w.slice(0, w.indexOf('='))] = expand(w.slice(w.indexOf('=') + 1))
    }
    if (words[0] === 'cd') dir = to(words[1], dir)
    else if (words.length) {
      const c = words.indexOf('-C')
      const ran = c >= 0 ? to(words[c + 1] ?? '.', dir) : dir
      const piped = /(?:^|[^|])\|&?$/.test(text.slice(Math.max(0, m.index - 3), m.index)) // after `|` or `|&`
      last = piped && c < 0 ? last : ran
      all.add(last)
      if (MILESTONE.test(bare(part))) milestones.add(ran)
    }
    if (outer !== undefined && depth <= 0) [dir, outer] = [outer, undefined]
  }
  return { all, milestones }
}
// The folder of the file a file tool's call reads or edits, when its path is absolute and outside ~/.claude: the
// skills, plugins and memory there are no project's work, though a skill or a plugin there may be a repo's folder.
const fileDir = (e: ToolCallInput) => {
  const file =
    e.tool === 'Read' || e.tool === 'Edit' || e.tool === 'Write'
      ? e.file_path
      : e.tool === 'NotebookEdit'
        ? e.notebook_path
        : undefined
  return file?.startsWith('/') && !inside(file, `${home}/.claude`)
    ? resolve('/', file.slice(0, file.lastIndexOf('/')))
    : undefined
}
// Where a folder lands past symbolic links (`~/repos` for `~/.repos`, say); one that isn't there lands where its
// parent does.
const real = async ($: EngineInterface, dir: string): Promise<string> => {
  const landed = (await $.fs.stat(dir, { resolve: true }).catch(() => undefined))?.realPath
  const i = dir.lastIndexOf('/')
  return landed ?? (i > 0 ? `${await real($, dir.slice(0, i))}${dir.slice(i)}` : dir)
}
const reals = ($: EngineInterface, dirs: Iterable<string>) => Promise.all([...dirs].map(d => real($, d)))
const touch = (dirs: Iterable<string>) => {
  for (const d of dirs) {
    const i = recent.indexOf(d)
    if (i >= 0) recent.splice(i, 1)
    recent.push(d)
  }
  recent.splice(0, recent.length - 20)
}
// The repo a folder is in: the nearest folder at or above it that holds a `.git`.
const repoOf = async ($: EngineInterface, dir: string) => {
  for (let d = dir; d; d = d.slice(0, d.lastIndexOf('/')))
    if (await $.fs.exists(`${d}/.git`).catch(() => false)) return d
}
// The folder a new roadmap covers: the repo of the newest folder this session touched that is in one, past the
// project-roadmap skill's own files (the agent reads its example just before it publishes); else the session's folder.
const workDir = async ($: EngineInterface) => {
  for (const d of [...recent].reverse()) {
    const repo = /\/project-roadmap(?:\/|$)/.test(d) ? undefined : await repoOf($, await real($, d))
    if (repo) return repo
  }
  const cwd = await real($, await $.session.cwd())
  return (await repoOf($, cwd)) ?? cwd
}

const load = async ($: EngineInterface) => {
  folder ||= await $.session.root()
  // Until the list exists, a session reads what an earlier version kept for the folder it started in, which then covers
  // that folder: `roadmaps:<root>`, or the first version's one link under `link:<root>`. Neither is written again,
  // so a session still on an earlier version only ever reads the shape it knows.
  // ponytail: other start folders' lists stay behind, and such a session keeps its own counts there; merge them if that bites.
  const v = (await $.store.get(KEY)) ?? (await $.store.get(`roadmaps:${folder}`)) ?? (await $.store.get(`link:${folder}`))
  const maps = ((Array.isArray(v) ? v : [v]) as Partial<Roadmap>[]).flatMap(r =>
    typeof r?.url === 'string' && Number.isFinite(r.behind)
      ? [{ ...r, dir: typeof r.dir === 'string' ? r.dir : folder } as Roadmap]
      : [],
  )
  for (const r of maps) if (r.behind < (heard.get(r.url) ?? 0)) heard.set(r.url, r.behind) // another session synced it
  return maps
}
// The roadmaps that work in folder `path` counts toward: those of the deepest roadmap folder that holds it, past the
// ones filed in no repo (under ~, say) when `path` is in one: such a roadmap counts only the work outside the repos
// under it. A repo inside another, such as a worktree or a submodule, counts toward the outer one's roadmaps.
const at = async ($: EngineInterface, maps: Roadmap[], path: string) => {
  let holds = maps.filter(r => inside(path, r.dir))
  const repo = holds.length ? await repoOf($, path) : undefined
  if (repo) {
    const ok = await Promise.all(holds.map(async r => inside(r.dir, repo) || (await repoOf($, r.dir)) !== undefined))
    holds = holds.filter((_, i) => ok[i])
  }
  const depth = Math.max(-1, ...holds.map(r => r.dir.length))
  return holds.filter(r => r.dir.length === depth)
}
// Of a folder's roadmaps, the ones this session's milestones there count toward: its pick, else all of them.
const targets = (mine: Roadmap[]) => {
  const pick = mine.find(r => r.url === picks.get(r.dir))
  return pick ? [pick] : mine
}
const show = ($: EngineInterface, maps: Roadmap[]) => {
  const most = Math.max(0, ...targets(maps.filter(r => r.dir === here)).map(r => r.behind))
  return $.ui.status(most > 0 ? `roadmap: ${most} behind` : undefined)
}
const save = async ($: EngineInterface, maps: Roadmap[]) => {
  await $.store.set(KEY, maps) // an empty list stays, so an earlier version's list doesn't come back
  show($, maps)
}
// Saves `r` in place of `old`, or as a new roadmap, and makes it this session's in its folder.
// A republish can turn a code/ url into the short one another entry already has: that entry goes.
const keep = ($: EngineInterface, maps: Roadmap[], r: Roadmap, old?: Roadmap) => {
  picks.set(r.dir, r.url)
  here = r.dir
  heard.set(r.url, r.behind)
  const next = old ? maps.map(m => (m === old ? r : m)) : [...maps, r]
  return save($, next.filter(m => m === r || m.url !== r.url))
}

// The page's <title>, which the project-roadmap skill sets to the roadmap's name.
const titleOf = async ($: EngineInterface, path?: string) => {
  const html = path ? await $.fs.read(path).catch(() => '') : ''
  const title = /<title>([^<]*)<\/title>/i.exec(html)?.[1]?.trim()
  return title ? title.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&') : undefined
}

const name = (r: Roadmap) => (r.title ? `"${r.title}" (${r.url})` : r.url)
const line = (r: Roadmap) => `${name(r)}, ${r.behind} behind`
const behindText = (r: Roadmap) => `${r.behind} milestone(s) behind (commits, PRs, closed beads since its last update)`
// What filing a roadmap in no repo means, said where it is filed.
const noRepo = async ($: EngineInterface, r: Roadmap) =>
  (await repoOf($, r.dir)) ? '' : ` ${short(r.dir)} is in no repo, so the repos under it don't count toward it.`
// What the agent reads when it starts working in a roadmap folder: its roadmaps, this session's one, when to update.
const pointer = (maps: Roadmap[], mine: Roadmap[]) => {
  const [one, ...more] = mine
  const where = short(one?.dir ?? '')
  if (one && !more.length)
    return (
      `Folder ${where} has a project roadmap: ${name(one)}. When work there finishes a step, lands a decision or changes the plan, update it with the project-roadmap skill.` +
      (one.behind > 0 ? ` It is ${behindText(one)}.` : '')
    )
  const pick = mine.find(r => r.url === picks.get(r.dir))
  return (
    `Folder ${where} has ${mine.length} project roadmaps, one per effort: ${mine.map(r => `${maps.indexOf(r) + 1}. ${line(r)}`).join('; ')}. ` +
    'When work there finishes a step, lands a decision or changes the plan, update the one it belongs to with the project-roadmap skill. ' +
    (pick
      ? `This session works on ${name(pick)}.`
      : "The first one you update becomes this session's roadmap there; until then, milestones there count toward all of them.")
  )
}
const nudge = (due: Roadmap[]) => {
  const [one, ...more] = due
  return one && !more.length
    ? `Roadmap ${name(one)} is ${behindText(one)}. If this work finished a step or changed the plan, update it with the project-roadmap skill; otherwise carry on.`
    : `These roadmaps are behind by the milestones since each one's last update: ${due.map(line).join('; ')}. If this work finished a step or changed the plan of one, update that one with the project-roadmap skill, and it becomes this session's roadmap in its folder; otherwise carry on.`
}
// The nudge for the roadmaps that grew since the main loop last heard, among those this session's milestones counted
// toward and still count toward, if any.
const news = (maps: Roadmap[]) => {
  const due = maps.filter(
    r =>
      raised.has(r.url) &&
      r.behind > (heard.get(r.url) ?? 0) &&
      targets(maps.filter(m => m.dir === r.dir)).includes(r),
  )
  for (const r of due) heard.set(r.url, r.behind)
  return due.length ? nudge(due) : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    folder = await $.session.root()
    home = (await $.env.get('HOME')) ?? ''
    here = undefined
    for (const s of [picks, heard, raised, told]) s.clear()
    recent.length = 0
    await $.command.register({
      name: 'roadmap',
      description: 'Show, link, move, pick or unlink the roadmaps of your folders',
      argumentHint: '[link <url> [folder] [title] | use <n> | unlink [n]]',
    })
    const maps = await load($)
    for (const r of maps) heard.set(r.url, r.behind)
    show($, maps)

    return next(e)
  })

  // The pointer of the folder the session is in, at startup, resume, /clear and compaction.
  // Only a compaction or a fork keeps this session's picks.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id) return r
    if (e.source !== 'compact' && e.source !== 'fork') {
      picks.clear()
      here = undefined
    }
    told.clear()
    const maps = await load($)
    const mine =
      here === undefined ? await at($, maps, await real($, await $.session.cwd())) : maps.filter(m => m.dir === here)
    const [one] = mine
    here = one?.dir
    show($, maps)
    if (!one) return r
    told.add(one.dir)
    for (const m of mine) heard.set(m.url, m.behind)

    return { ...r, additionalContext: [...(r.additionalContext ?? []), pointer(maps, mine)] }
  })

  // Catches milestones a subagent made, or a turn that ended without another call.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    if (r.block || e.agent_id) return r
    const text = news(await load($))

    return text ? { ...r, additionalContext: [...(r.additionalContext ?? []), text] } : r
  })

  on('tool.call', async ($, e, next) => {
    const cwd = e.tool === 'Bash' ? await $.session.cwd() : '' // where the command starts, before a `cd` in it
    const ran = await next(e)
    // ponytail: a pipe exits as its last stage does, so `git commit … | tail -3` counts even when the commit fails;
    // reading git's `[branch sha]` line would catch it, unless the tail cuts it off.
    if (ran.deny !== undefined || ran.isError) return ran
    const maps = await load($)

    // The project-roadmap skill publishes roadmap.html with the map icon; a republish of a linked page syncs it.
    // ponytail: a republish by a code/ url stores the short url the publish prints, so another session working on
    // the code/ url loses its pick; keep the old url as an alias if that bites.
    if (e.tool === 'Artifact' && (e.action ?? 'publish') === 'publish' && !e.asset) {
      const url = urlIn(ran.text)
      const linked = urlIn(e.url)
      const old = maps.find(r => r.url === url || r.url === linked)
      if (url && (old || (e.icon === 'map' && /roadmap[^/]*\.html$/i.test(e.file_path ?? '')))) {
        const title = (await titleOf($, e.file_path)) ?? old?.title
        const r = { url, title, behind: 0, dir: old?.dir ?? (await workDir($)) }
        await keep($, maps, r, old)
        if (old) return ran
        $.ui.toast(`Roadmap added for ${short(r.dir)}: ${title ?? url}`)
        told.add(r.dir)
        const text = `Roadmap ${name(r)} now covers ${short(r.dir)}: milestones there count toward it.${await noRepo($, r)} If its work lives in another folder, the user can move it with /roadmap link ${url} <folder>.`
        return { ...ran, context: [...(ran.context ?? []), text] }
      }
    }

    const shell = e.tool === 'Bash' ? foldersOf(e.command, cwd) : undefined
    const file = fileDir(e)
    const seen = shell?.all ?? (file ? [file] : [])
    touch(seen)
    if (!maps.length) return ran

    if (e.tool === 'ArtifactData' && WRITES.includes(e.action)) {
      const url = urlIn(e.url)
      const old = maps.find(r => r.url === url)
      if (old) {
        await keep($, maps, { ...old, behind: 0 }, old)
        return ran
      }
    }
    let now = maps
    const hit = new Set<Roadmap>()
    for (const d of await reals($, shell?.milestones ?? [])) for (const r of targets(await at($, maps, d))) hit.add(r)
    if (hit.size) {
      for (const r of hit) raised.add(r.url)
      now = maps.map(r => (hit.has(r) ? { ...r, behind: r.behind + 1 } : r))
      await save($, now)
    }
    if (e.agentId !== undefined) return ran

    // The pointer of each roadmap folder the main loop starts working in, then the nudge.
    const texts: string[] = []
    for (const d of await reals($, seen)) {
      const mine = await at($, now, d)
      const dir = mine[0]?.dir
      if (dir === undefined) continue
      if (here !== dir) {
        here = dir
        show($, now)
      }
      if (told.has(dir)) continue
      told.add(dir)
      for (const m of mine) heard.set(m.url, m.behind)
      texts.push(pointer(now, mine))
    }
    const text = news(now)
    if (text) texts.push(text)

    return texts.length ? { ...ran, context: [...(ran.context ?? []), ...texts] } : ran
  })

  on('command.run', { command: 'roadmap' }, async ($, e) => {
    const [verb = '', arg = '', ...words] = e.args.trim().split(/\s+/)
    const maps = await load($)
    const listing = maps.length
      ? maps
          .map((r, i) => `${i + 1}. ${short(r.dir)}: ${line(r)}${r.url === picks.get(r.dir) ? ' (this session)' : ''}`)
          .join('\n')
      : 'No roadmap linked yet. Publish one with /project-roadmap, or run /roadmap link <url> [folder].'
    if (verb === 'link') {
      const url = urlIn(arg)
      if (!url) return { text: 'Usage: /roadmap link <claude.ai artifact URL> [folder] [title]' }
      // Linking a listed page renames or moves it; the page itself didn't change, so its count stays.
      const old = maps.find(r => r.url === url)
      const path = /^(?:[/~]|\.\.?(?:\/|$))/.test(words[0] ?? '') ? words.shift() : undefined // a folder, not a title
      const dir = path ? await real($, resolve(await $.session.cwd(), path)) : (old?.dir ?? (await workDir($)))
      const r = { url, title: words.join(' ') || old?.title, behind: old?.behind ?? 0, dir }
      await keep($, maps, r, old)
      return { text: `Roadmap ${name(r)} covers ${short(dir)}.${await noRepo($, r)} This session works on it there.` }
    }
    if (verb === 'use' || verb === 'unlink') {
      const mine = maps.filter(m => m.dir === here)
      const r = arg
        ? (maps[Number(arg) - 1] ?? maps.find(m => m.url === urlIn(arg)))
        : (mine.find(m => m.url === picks.get(m.dir)) ??
          (mine.length === 1 ? mine[0] : maps.length === 1 ? maps[0] : undefined))
      if (!r) return { text: maps.length ? `Which one? Run /roadmap ${verb} <number>.\n${listing}` : listing }
      if (verb === 'use') {
        picks.set(r.dir, r.url)
        here = r.dir
        show($, maps)
        return { text: `This session works on ${name(r)} in ${short(r.dir)}.` }
      }
      await save($, maps.filter(m => m !== r))
      return { text: `Roadmap unlinked: ${name(r)}.` }
    }

    return { text: maps.length ? `Roadmaps:\n${listing}` : listing }
  })
}
