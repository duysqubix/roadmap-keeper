import type { EngineInterface, Register } from 'claude-code'

// The project root's roadmaps, one per effort, kept across sessions in $.store under `roadmaps:<root>`.
// `behind` counts milestones (commits, PRs, closed beads) since that roadmap's last write.
// Each session works on one of them, its focus: the one it last published, wrote to, linked or picked.
// Until it has one, its milestones count toward all of them.
// ponytail: the focus lives in this module, so a plugin reload drops it until the next write; move it to $.state if that bites.
// ponytail: each hook saves the whole list it loaded, so overlapping hooks (parallel calls, two sessions) can lose
// a count or a sync; keep each count under its own key if that bites.
type Roadmap = { url: string; title?: string; behind: number }

const ARTIFACT_URL = /https:\/\/claude\.ai\/(?:code\/)?artifact\/[\w-]+/
const MILESTONE =
  /\bgit\b[^;&|\n]*\scommit\b(?![^;&|\n]*\s--amend\b)|\bgh\b[^;&|\n]*\spr\s+(?:create|merge)\b|\bbd\s+close\b/
const WRITES = ['set', 'update', 'delete', 'str_replace', 'batch']

// The command without heredoc bodies and quoted text, so a commit message or a grep pattern is no milestone.
const bare = (command: string) =>
  command
    .replace(/<<-?\s*['"]?(\w+)['"]?[^\n]*\n[\s\S]*?\n\s*\1\b/g, '')
    .replace(/"(?:\\.|[^"\\])*"|'[^']*'/g, '""')

let folder = ''
let focus: string | undefined // the url of this session's roadmap
const heard = new Map<string, number>() // per url, the `behind` count the main loop last heard about

const key = () => `roadmaps:${folder}`
const urlIn = (text?: string) => text?.match(ARTIFACT_URL)?.[0]
const load = async ($: EngineInterface) => {
  // The first version kept one link under `link:<root>`. It is read until the list exists and never written,
  // so a session still running that version only ever reads the shape it knows.
  // ponytail: such a session keeps its own count there until it updates; sync the two if both versions run side by side.
  const v = (await $.store.get(key())) ?? (await $.store.get(`link:${folder}`))
  const maps = ((Array.isArray(v) ? v : [v]) as Roadmap[]).filter(
    r => typeof r?.url === 'string' && Number.isFinite(r.behind),
  )
  for (const r of maps) if (r.behind < (heard.get(r.url) ?? 0)) heard.set(r.url, r.behind) // another session synced it
  if (!maps.some(r => r.url === focus)) focus = undefined
  return maps
}
// The roadmaps this session's milestones count toward.
const targets = (maps: Roadmap[]) => maps.filter(r => !focus || r.url === focus)
const show = ($: EngineInterface, maps: Roadmap[]) => {
  const most = Math.max(0, ...targets(maps).map(r => r.behind))
  return $.ui.status(most > 0 ? `roadmap: ${most} behind` : undefined)
}
const save = async ($: EngineInterface, maps: Roadmap[]) => {
  await $.store.set(key(), maps) // an empty list stays, so the first version's link doesn't come back
  show($, maps)
}
// Saves `r` in place of `old`, or as a new roadmap, and makes it this session's.
// A republish can turn a code/ url into the short one another entry already has: that entry goes.
const keep = ($: EngineInterface, maps: Roadmap[], r: Roadmap, old?: Roadmap) => {
  focus = r.url
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
const pointer = (maps: Roadmap[]) => {
  const [one, ...more] = maps
  if (one && !more.length)
    return (
      `This folder has a project roadmap: ${name(one)}. When a step finishes, a decision lands or the plan changes, update it with the project-roadmap skill.` +
      (one.behind > 0 ? ` It is ${behindText(one)}.` : '')
    )
  const mine = maps.find(r => r.url === focus)
  return (
    `This folder has ${maps.length} project roadmaps, one per effort: ${maps.map((r, i) => `${i + 1}. ${line(r)}`).join('; ')}. ` +
    'When a step finishes, a decision lands or the plan changes, update the one the work belongs to with the project-roadmap skill. ' +
    (mine
      ? `This session works on ${name(mine)}.`
      : "The first one you update becomes this session's roadmap; until then, milestones count toward all of them.")
  )
}
const nudge = (due: Roadmap[]) => {
  const [one, ...more] = due
  return one && !more.length
    ? `Roadmap ${name(one)} is ${behindText(one)}. If this work finished a step or changed the plan, update it with the project-roadmap skill; otherwise carry on.`
    : `This folder's roadmaps are behind by the milestones since each one's last update: ${due.map(line).join('; ')}. If this work finished a step or changed the plan of one, update that one with the project-roadmap skill, and it becomes this session's roadmap; otherwise carry on.`
}
// The nudge for this session's roadmaps that grew since the main loop last heard, if any.
const news = (maps: Roadmap[]) => {
  const due = targets(maps).filter(r => r.behind > (heard.get(r.url) ?? 0))
  for (const r of due) heard.set(r.url, r.behind)
  return due.length ? nudge(due) : undefined
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    folder = await $.session.root()
    focus = undefined
    heard.clear()
    await $.command.register({
      name: 'roadmap',
      description: "Show, link, pick or unlink this folder's roadmaps",
      argumentHint: '[link <url> [title] | use <n> | unlink [n]]',
    })
    const maps = await load($)
    for (const r of maps) heard.set(r.url, r.behind)
    show($, maps)

    return next(e)
  })

  // Pointer at startup, resume, /clear and compaction. Only a compaction or a fork keeps this session's roadmap.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id) return r
    folder ||= await $.session.root()
    if (e.source !== 'compact' && e.source !== 'fork') focus = undefined
    const maps = await load($)
    show($, maps)
    if (!maps.length) return r
    for (const m of maps) heard.set(m.url, m.behind)

    return { ...r, additionalContext: [...(r.additionalContext ?? []), pointer(maps)] }
  })

  // Catches milestones a subagent made, or a turn that ended without another call.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    if (r.block || e.agent_id) return r
    const text = news(await load($))

    return text ? { ...r, additionalContext: [...(r.additionalContext ?? []), text] } : r
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
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
        const r = { url, title: (await titleOf($, e.file_path)) ?? old?.title, behind: 0 }
        if (!old) $.ui.toast(`Roadmap added: ${r.title ?? url}`)
        await keep($, maps, r, old)
        return ran
      }
    }
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
    if (e.tool === 'Bash' && MILESTONE.test(bare(e.command))) {
      const hit = targets(maps)
      now = maps.map(r => (hit.includes(r) ? { ...r, behind: r.behind + 1 } : r))
      await save($, now)
    }
    if (e.agentId !== undefined) return ran
    const text = news(now)

    return text ? { ...ran, context: [...(ran.context ?? []), text] } : ran
  })

  on('command.run', { command: 'roadmap' }, async ($, e) => {
    const [verb = '', arg = '', ...words] = e.args.trim().split(/\s+/)
    const maps = await load($)
    const listing = maps.length
      ? maps.map((r, i) => `${i + 1}. ${line(r)}${r.url === focus ? ' (this session)' : ''}`).join('\n')
      : `No roadmap linked to ${folder}. Publish one with /project-roadmap, or run /roadmap link <url>.`
    if (verb === 'link') {
      const url = urlIn(arg)
      if (!url) return { text: 'Usage: /roadmap link <claude.ai artifact URL> [title]' }
      // Linking a listed page renames it; the page itself didn't change, so its count stays.
      const old = maps.find(r => r.url === url)
      const r = { url, title: words.join(' ') || old?.title, behind: old?.behind ?? 0 }
      await keep($, maps, r, old)
      return { text: `Roadmap linked to ${folder}: ${name(r)}. This session works on it.` }
    }
    if (verb === 'use' || verb === 'unlink') {
      const r = arg
        ? (maps[Number(arg) - 1] ?? maps.find(m => m.url === urlIn(arg)))
        : (maps.find(m => m.url === focus) ?? (maps.length === 1 ? maps[0] : undefined))
      if (!r) return { text: maps.length ? `Which one? Run /roadmap ${verb} <number>.\n${listing}` : listing }
      if (verb === 'use') {
        focus = r.url
        show($, maps)
        return { text: `This session works on ${name(r)}.` }
      }
      if (focus === r.url) focus = undefined
      await save($, maps.filter(m => m !== r))
      return { text: `Roadmap unlinked from ${folder}: ${name(r)}.` }
    }

    return { text: maps.length ? `Roadmaps for ${folder}:\n${listing}` : listing }
  })
}
