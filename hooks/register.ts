import type { EngineInterface, Register } from 'claude-code'

// The project root's roadmap, kept across sessions in $.store under `link:<root>`.
// `behind` counts milestones (commits, PRs, closed beads) since the roadmap's last write.
// ponytail: one roadmap per project root; add per-session links if several efforts share a folder (like ~).
// ponytail: parallel milestones can count once (read-modify-write race); serialize if the count must be exact.
type Link = { url: string; behind: number }

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
let nudged = 0 // the `behind` count the main loop last heard about

const key = () => `link:${folder}`
const load = async ($: EngineInterface) => {
  const link = (await $.store.get(key())) as Link | undefined
  if (link && link.behind < nudged) nudged = link.behind // another session synced it
  return link
}
const show = ($: EngineInterface, link?: Link) =>
  $.ui.status(link && link.behind > 0 ? `roadmap: ${link.behind} behind` : undefined)
const save = async ($: EngineInterface, link: Link) => {
  await $.store.set(key(), link)
  show($, link)
}

const behindText = (link: Link) =>
  `${link.behind} milestone(s) behind (commits, PRs, closed beads since its last update)`
const pointer = (link: Link) =>
  `This folder has a project roadmap: ${link.url}. When a step finishes, a decision lands or the plan changes, update it with the project-roadmap skill.` +
  (link.behind > 0 ? ` It is ${behindText(link)}.` : '')
const nudge = (link: Link) =>
  `Roadmap ${link.url} is ${behindText(link)}. If this work finished a step or changed the plan, update it with the project-roadmap skill; otherwise carry on.`

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    folder = await $.session.root()
    await $.command.register({
      name: 'roadmap',
      description: "Show, link or unlink this folder's roadmap",
      argumentHint: '[link <url> | unlink]',
    })
    const link = await load($)
    nudged = link?.behind ?? 0
    show($, link)

    return next(e)
  })

  // Pointer at startup, resume, /clear and compaction.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.agent_id) return r
    folder ||= await $.session.root()
    const link = await load($)
    if (!link) return r
    nudged = link.behind

    return { ...r, additionalContext: [...(r.additionalContext ?? []), pointer(link)] }
  })

  // Catches milestones a subagent made, or a turn that ended without another call.
  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    if (r.block || e.agent_id) return r
    const link = await load($)
    if (!link || link.behind <= nudged) return r
    nudged = link.behind

    return { ...r, additionalContext: [...(r.additionalContext ?? []), nudge(link)] }
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (ran.deny !== undefined || ran.isError) return ran
    let link = await load($)

    // The project-roadmap skill publishes roadmap.html with the map icon; a republish of the linked page syncs it.
    if (e.tool === 'Artifact' && (e.action ?? 'publish') === 'publish' && !e.asset) {
      const url = ran.text?.match(ARTIFACT_URL)?.[0]
      const isRoadmap = e.icon === 'map' && /roadmap[^/]*\.html$/i.test(e.file_path ?? '')
      const isLinked = !!link && (url === link.url || e.url?.match(ARTIFACT_URL)?.[0] === link.url)
      if (url && (isRoadmap || isLinked)) {
        if (link && !isLinked) $.ui.toast(`Roadmap link moved to ${url}`)
        nudged = 0
        await save($, { url, behind: 0 })
        return ran
      }
    }
    if (!link) return ran

    if (e.tool === 'ArtifactData' && WRITES.includes(e.action) && e.url?.match(ARTIFACT_URL)?.[0] === link.url) {
      nudged = 0
      if (link.behind > 0) await save($, { ...link, behind: 0 })
      return ran
    }
    if (e.tool === 'Bash' && MILESTONE.test(bare(e.command))) {
      link = { ...link, behind: link.behind + 1 }
      await save($, link)
    }
    if (e.agentId !== undefined || link.behind <= nudged) return ran
    nudged = link.behind

    return { ...ran, context: [...(ran.context ?? []), nudge(link)] }
  })

  on('command.run', { command: 'roadmap' }, async ($, e) => {
    const [verb, arg] = e.args.trim().split(/\s+/)
    if (verb === 'link') {
      const url = arg?.match(ARTIFACT_URL)?.[0]
      if (!url) return { text: 'Usage: /roadmap link <claude.ai artifact URL>' }
      nudged = 0
      await save($, { url, behind: 0 })
      return { text: `Roadmap linked to ${folder}: ${url}` }
    }
    if (verb === 'unlink') {
      await $.store.delete(key())
      show($)
      return { text: `Roadmap unlinked from ${folder}.` }
    }
    const link = await load($)

    return {
      text: link
        ? `Roadmap for ${folder}: ${link.url} (${link.behind} behind).`
        : `No roadmap linked to ${folder}. Publish one with /project-roadmap, or run /roadmap link <url>.`,
    }
  })
}
