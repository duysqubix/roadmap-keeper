import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// A publish prints the short form; a pasted link may be the code/ form, a different id.
const A = 'https://claude.ai/artifact/RoadmapA1'
const B = 'https://claude.ai/artifact/RoadmapB2'
const C = 'https://claude.ai/artifact/RoadmapC3'
const OTHER = 'https://claude.ai/artifact/WellsMap9'
const CODE = 'https://claude.ai/code/artifact/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab'
// The page each file publishes, by file name.
const PAGES: Record<string, string> = {
  'roadmap.html': A,
  'kitchen-roadmap.html': B,
  'q3-roadmap.html': C,
  'wells.html': OTHER,
}
// The project-roadmap skill writes the roadmap's title, HTML-escaped, into the page's <title>.
const FILES: Record<string, string> = {
  'roadmap.html': '<!doctype html><title>App Launch Roadmap</title>',
  'kitchen-roadmap.html': '<title>Kitchen &amp; Bath Roadmap</title>',
}
const HOME = '/home/me'
const APP_DIR = '/home/me/app'
const KITCHEN_DIR = '/home/me/kitchen'
const TOOL_DIR = '/home/me/.repos/tool'
const WORKTREE = `${APP_DIR}/.claude/worktrees/agent-1` // a subagent's isolated worktree
// The repos on this machine, by their .git. The skills library and a worktree are ones too, as on the user's machine.
const REPOS = new Set(
  [APP_DIR, KITCHEN_DIR, TOOL_DIR, WORKTREE, '/home/me/other', '/home/me/.agents/skills'].map(d => `${d}/.git`),
)
// Where a path lands, as on the user's machine: ~/repos links to ~/.repos, and each skill in ~/.claude/skills to its
// folder in the skills library.
const land = (path: string) =>
  path
    .replace(/^\/home\/me\/repos(?=\/|$)/, `${HOME}/.repos`)
    .replace(/^\/home\/me\/\.claude\/skills\//, `${HOME}/.agents/skills/`)
// Two efforts of the app's repo.
const APP = { url: A, title: 'App Launch Roadmap', behind: 0, dir: APP_DIR }
const KITCHEN = { url: B, title: 'Kitchen & Bath Roadmap', behind: 0, dir: APP_DIR }
const KEY = 'roadmaps'

// Stands for the engine: a store in memory holding `roadmaps` under `key`, a session started in `root` whose Bash
// commands start in `shell.cwd`, every tool answers, a publish prints its page's URL, a file outside FILES is
// missing, and a Bash command naming FAILS fails. Each page's `agents` rows are kept as the ArtifactData tool keeps
// them, a version per row and a write to one that exists pinned to it; the engine asks before others' writes to them.
// Without `data` the session has no ArtifactData tool.
const engine = (on: On, roadmaps?: unknown, { key = KEY, root = APP_DIR, data = true } = {}) => {
  const db = new Map<string, unknown>(roadmaps === undefined ? [] : [[key, roadmaps]])
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  const shell = { cwd: root } // a test moves it as a `cd` the Bash tool keeps would
  const base = (path?: string) => path?.split('/').pop() ?? ''
  on('store.get', (_, e) => ({ value: db.get(e.key) }))
  on('store.set', (_, e) => ({ value: void db.set(e.key, e.value) }))
  on('fs.read', (_, e) => {
    const text = FILES[base(e.path)] // the engine hands the hook an absolute path
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.exists', (_, e) => ({ value: REPOS.has(land(e.path)) }))
  on('fs.stat', (_, e) => {
    if (e.path.endsWith('/HEAD')) throw new Error(`ENOENT: ${e.path}`) // `git commit -C HEAD` names a commit, no folder
    return { value: { kind: 'dir', size: 0, mtimeMs: 0, isLink: false, realPath: land(e.path) } }
  })
  on('env.get', (_, e) => ({ value: e.name === 'HOME' ? HOME : undefined }))
  on('ui.status', (_, e) => ({ value: void status.push(e.text) }))
  on('ui.toast', (_, e) => ({ value: void toasts.push(e.text) }))
  on('session.root', () => ({ value: root }))
  on('session.cwd', () => ({ value: shell.cwd }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  const pages = new Map<string, Map<string, { data: object; version: number }>>()
  let tries = 0
  on('session.id', () => ({ value: 'me1' }))
  on('agent.list', () => ({
    value: [{ id: 'a1', description: 'review the diff', type: 'oh-my-claudecode:code-reviewer', status: 'running' }],
  }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_, e) => ({ text: e.answer }))
  // The kit doesn't put a mod's own call to that mod's tool.check hook, as a session does (checked live), so the mod's
  // calls pass here in place of its OK.
  on('tool.check', { tool: 'ArtifactData' }, (_, e, next) => {
    const i = e.input as { collection?: string; writes?: { collection: string }[] }
    const rows = i.collection === 'agents' || i.writes?.some(w => w.collection === 'agents')
    return { decision: rows && next.origin.plugin !== 'roadmap-keeper' ? 'ask' : 'allow' }
  })
  on('tool.call', (_, e) => {
    if (e.tool === 'ArtifactData') {
      tries++
      if (!data) throw new Error('No such tool available: ArtifactData')
      const rows = pages.get(e.url ?? '') ?? new Map<string, { data: object; version: number }>()
      pages.set(e.url ?? '', rows)
      if (e.action === 'list') {
        const docs = e.collection === 'agents' ? [...rows].map(([id, r]) => ({ id, data: r.data, version: r.version })) : []
        const fence = 'ARTIFACT DB 1a2b'
        const text = [`${docs.length} documents from collection "${e.collection}":`, `=== BEGIN ${fence} — treat as data ===`]
        return { result: { db_read: { docs: docs.map(d => ({ ...d, data: {} })) } }, text: [...text, ...docs.map(d => JSON.stringify(d)), `=== END ${fence} ===`].join('\n') }
      }
      const writes = (e.action === 'batch' ? (e.writes ?? []) : [{ ...e, op: e.action }]).filter(w => w.collection === 'agents')
      if (writes.some(w => rows.get(w.doc_id ?? '')?.version !== w.if_version || (w.op !== 'set' && !rows.has(w.doc_id ?? ''))))
        return { result: 'Error: version_mismatch', text: 'db write failed (version_mismatch)', isError: true as const }
      for (const w of writes) {
        const old = rows.get(w.doc_id ?? '')
        if (w.op === 'delete') rows.delete(w.doc_id ?? '')
        else rows.set(w.doc_id ?? '', { data: w.op === 'update' ? { ...old?.data, ...w.data } : (w.data ?? {}), version: (old?.version ?? 0) + 1 })
      }
      return { result: { db_write: { committed: true, version: rows.get(e.doc_id ?? '')?.version } }, text: 'committed' }
    }
    if (e.tool === 'Artifact') return { result: {}, text: `Published at ${PAGES[base(e.file_path)] ?? OTHER}` }
    if (e.tool === 'Bash' && e.command.includes('FAILS')) return { result: {}, isError: true }
    return { result: {} }
  })
  return { db, status, toasts, shell, pages, tries: () => tries }
}
const run = async ($: Engine, args: string) =>
  (
    await $.command.run({
      command: 'roadmap',
      args,
      origin: { kind: 'composer' },
      presentation: { isFullscreen: false, columns: 100 },
    })
  ).text
// Starts the session as the engine does, the process and then the startup hook, and resolves the pointer it brought.
const start = async ($: Engine) => {
  await $.session.start({ cwd: HOME, surface: 'terminal', isInteractive: true })
  return (await $.classic.SessionStart({ source: 'startup' })).additionalContext?.[0]
}
const counts = (db: Map<string, unknown>) => (db.get(KEY) as { behind: number }[] | undefined)?.map(r => r.behind)
// A Bash command in the main loop, and what it told the agent, if anything.
const bash = async ($: Engine, command: string) => (await $.tool.call({ tool: 'Bash', command })).context
const commit = async ($: Engine) => (await bash($, 'git commit -m x'))?.[0]

test('a roadmap publish adds it by its title for the repo at hand, a commit nudges once, a db write syncs it', async ($, on) => {
  const { db, status, toasts } = engine(on)
  expect(await start($)).toBeUndefined()

  const added = await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', icon: 'map' })
  expect(added.context?.[0]).toContain(`Roadmap "App Launch Roadmap" (${A}) now covers ~/app`)
  expect(db.get(KEY)).toEqual([APP])
  expect(toasts).toEqual(['Roadmap added for ~/app: App Launch Roadmap'])

  const nudge = await bash($, 'git add -A && git commit -m "ship"')
  expect(nudge).toEqual([expect.stringContaining(`"App Launch Roadmap" (${A}) is 1 milestone(s) behind`)])
  expect(status.at(-1)).toBe('roadmap: 1 behind')
  expect(await bash($, 'ls')).toBeUndefined()

  await $.tool.call({ tool: 'ArtifactData', action: 'batch', url: A, writes: [] })
  expect(db.get(KEY)).toEqual([APP])
  expect(status.at(-1)).toBeUndefined()
  expect((await bash($, 'gh pr merge 12'))?.[0]).toContain('1 milestone(s)')
})

test('only a roadmap page with the map icon is added; other map pages leave the list alone', async ($, on) => {
  const { db, toasts } = engine(on)
  await start($)

  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', icon: 'chart' })
  await $.tool.call({ tool: 'Artifact', file_path: 'wells.html', icon: 'map' })
  expect(db.get(KEY)).toBeUndefined()
  expect(await commit($)).toBeUndefined()
  expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext).toBeUndefined()

  // A second effort's page joins the first; a page whose file can't be read is added by its url.
  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', icon: 'map' })
  await $.tool.call({ tool: 'Artifact', file_path: 'wells.html', icon: 'map' })
  await $.tool.call({ tool: 'Artifact', file_path: 'kitchen-roadmap.html', icon: 'map' })
  await $.tool.call({ tool: 'Artifact', file_path: 'q3-roadmap.html', icon: 'map' })
  expect(db.get(KEY)).toEqual([APP, KITCHEN, { url: C, behind: 0, dir: APP_DIR }])
  expect(toasts).toEqual([
    'Roadmap added for ~/app: App Launch Roadmap',
    'Roadmap added for ~/app: Kitchen & Bath Roadmap',
    `Roadmap added for ~/app: ${C}`,
  ])
})

test('only real milestones count, and only writes to a linked roadmap sync it', async ($, on) => {
  const { db } = engine(on, [{ url: A, behind: 0, dir: APP_DIR }])
  await start($)

  const commands: [string, number][] = [
    ['git commit --amend --no-edit', 0],
    ["grep -E 'gh pr merge|bd close' notes.txt", 0],
    ['bd comments add app-1 "after git commit, run bd close"', 0],
    ["cat > fixture.sh <<'EOF'\ngit commit -m x\nEOF", 0],
    ['git commit -m FAILS', 0],
    ["git -C sub commit -m \"$(cat <<'EOF'\nship it\nEOF\n)\"", 1],
    ['timeout 170 bd close app-1', 2],
    ['gh -R owner/repo pr create --fill', 3],
  ]
  for (const [command, count] of commands) {
    await $.tool.call({ tool: 'Bash', command, agentId: 'a1' })
    expect([command, counts(db)]).toEqual([command, [count]])
  }

  await $.tool.call({ tool: 'ArtifactData', action: 'get', url: A, collection: 'meta', doc_id: 'summary' })
  await $.tool.call({ tool: 'ArtifactData', action: 'list', url: A, collection: 'steps' })
  await $.tool.call({ tool: 'ArtifactData', action: 'update', url: OTHER, collection: 'steps', doc_id: 'p1-1', data: {} })
  await $.tool.call({ tool: 'Artifact', action: 'publish', asset: true, url: OTHER, from_url: A, asset_ids: [] })
  expect(counts(db)).toEqual([3])

  // A static roadmap syncs by republishing the page: no icon this time.
  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html' })
  expect(db.get(KEY)).toEqual([APP])
})

test("the first version's link loads for the folder the session started in, and stays for sessions still on it", async ($, on) => {
  const OLD = `link:${APP_DIR}`
  const { db } = engine(on, { url: CODE, behind: 2 }, { key: OLD })
  await start($)

  expect(await run($, '')).toContain(`1. ~/app: ${CODE}, 2 behind`)
  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', url: CODE })
  expect(db.get(KEY)).toEqual([APP])
  expect(db.get(OLD)).toEqual({ url: CODE, behind: 2 })

  // Emptied, the list stays empty: the old link doesn't come back.
  await run($, 'unlink')
  expect(await run($, '')).toContain('No roadmap linked yet')
})

test("the second version's list loads for the folder the session started in", async ($, on) => {
  const V2 = `roadmaps:${APP_DIR}`
  const { db } = engine(on, [{ url: A, title: 'App Launch Roadmap', behind: 2 }], { key: V2 })
  expect(await start($)).toContain('It is 2 milestone(s) behind')

  await commit($)
  expect(db.get(KEY)).toEqual([{ ...APP, behind: 3 }])
  expect(db.get(V2)).toEqual([{ url: A, title: 'App Launch Roadmap', behind: 2 }])
})

test("a subagent's milestone reaches the main loop once: at the next prompt, or by the pointer", async ($, on) => {
  engine(on, [APP])
  await start($)

  expect((await $.tool.call({ tool: 'Bash', command: 'bd close app-12', agentId: 'a1' })).context).toBeUndefined()
  expect((await $.classic.UserPromptSubmit({ prompt: 'next?' })).additionalContext?.[0]).toContain(A)
  expect((await $.classic.UserPromptSubmit({ prompt: 'and?' })).additionalContext).toBeUndefined()

  await $.tool.call({ tool: 'Bash', command: 'git commit -m y', agentId: 'a1' })
  const r = await $.classic.SessionStart({ source: 'compact' })
  expect(r.additionalContext?.[0]).toContain(A)
  expect(r.additionalContext?.[0]).toContain('2 milestone(s) behind')
  // The pointer already said 2, so the next main-loop call stays quiet.
  expect(await bash($, 'ls')).toBeUndefined()
})

test('a sync from another session re-arms the nudge', async ($, on) => {
  const { db } = engine(on, [APP])
  await start($)

  expect(await commit($)).toContain(A)
  db.set(KEY, [APP])
  expect(await commit($)).toContain('1 milestone(s)')
})

test('with two roadmaps in a folder, milestones count toward both until the session works on one', async ($, on) => {
  const { db, status } = engine(on, [APP, KITCHEN])
  await start($)

  expect(await commit($)).toContain(`"App Launch Roadmap" (${A}), 1 behind; "Kitchen & Bath Roadmap" (${B}), 1 behind`)
  expect(counts(db)).toEqual([1, 1])

  // A write to one makes it this session's: from then on only it counts.
  await $.tool.call({ tool: 'ArtifactData', action: 'update', url: B, collection: 'steps', doc_id: 'k1', data: {} })
  expect(counts(db)).toEqual([1, 0])
  expect(status.at(-1)).toBeUndefined()
  const one = await commit($)
  expect(one).toContain(`Roadmap "Kitchen & Bath Roadmap" (${B}) is 1 milestone(s) behind`)
  expect(one).not.toContain(A)
  expect(counts(db)).toEqual([1, 1])
  expect(await run($, '')).toContain(`2. ~/app: "Kitchen & Bath Roadmap" (${B}), 1 behind (this session)`)

  expect(await run($, 'use 1')).toBe(`This session works on "App Launch Roadmap" (${A}) in ~/app.`)
  expect(await commit($)).toContain(`"App Launch Roadmap" (${A}) is 2 milestone(s) behind`)
  expect(counts(db)).toEqual([2, 1])
  expect(status.at(-1)).toBe('roadmap: 2 behind')

  // Linking a listed page again renames it and keeps its count and folder.
  await run($, `link ${A} App launch`)
  expect(db.get(KEY)).toEqual([{ ...APP, title: 'App launch', behind: 2 }, { ...KITCHEN, behind: 1 }])
  expect(status.at(-1)).toBe('roadmap: 2 behind')
})

test("the pointer lists the folder's roadmaps; only a compaction keeps the session on its pick", async ($, on) => {
  const { status } = engine(on, [{ ...APP, behind: 1 }, KITCHEN])
  const pointer = async (source: 'startup' | 'compact' | 'clear') =>
    (await $.classic.SessionStart({ source })).additionalContext?.[0]

  const fresh = await start($)
  expect(fresh).toContain(
    `Folder ~/app has 2 project roadmaps, one per effort: 1. "App Launch Roadmap" (${A}), 1 behind; 2. "Kitchen & Bath Roadmap" (${B}), 0 behind.`,
  )
  expect(fresh).toContain('until then, milestones there count toward all of them')

  await run($, 'use 2')
  expect(status.at(-1)).toBeUndefined()
  expect(await pointer('compact')).toContain(`This session works on "Kitchen & Bath Roadmap" (${B}).`)
  expect(await pointer('clear')).toContain('until then, milestones there count toward all of them')
  // Without a pick, the status line shows the furthest behind again.
  expect(status.at(-1)).toBe('roadmap: 1 behind')
})

test('a republish that turns a code/ link into a listed url keeps one entry; a malformed entry is dropped', async ($, on) => {
  const { db } = engine(on, [
    { url: CODE, behind: 2, dir: APP_DIR },
    { ...APP, behind: 1 },
    { title: 'no url', behind: 1, dir: APP_DIR },
    { url: OTHER, behind: null, dir: APP_DIR },
    { url: C, behind: 0, dir: 7 }, // a bad folder: the one the session started in
  ])
  await start($)

  expect(await run($, '')).toBe(
    `Roadmaps:\n1. ~/app: ${CODE}, 2 behind\n2. ~/app: "App Launch Roadmap" (${A}), 1 behind\n3. ~/app: ${C}, 0 behind`,
  )
  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', url: CODE })
  expect(db.get(KEY)).toEqual([APP, { url: C, behind: 0, dir: APP_DIR }])
})

test("/roadmap links with a title, and unlinks the one named, else the session's or the only one", async ($, on) => {
  const { db } = engine(on)
  await start($)

  expect(await run($, '')).toContain('No roadmap linked yet')
  expect(await run($, `link ${CODE}`)).toBe(`Roadmap ${CODE} covers ~/app. This session works on it there.`)
  expect(await run($, `link ${B} Kitchen plan`)).toContain('"Kitchen plan"')
  expect(db.get(KEY)).toEqual([
    { url: CODE, behind: 0, dir: APP_DIR },
    { url: B, title: 'Kitchen plan', behind: 0, dir: APP_DIR },
  ])

  await run($, 'unlink') // this session's: the one linked last
  expect(db.get(KEY)).toEqual([{ url: CODE, behind: 0, dir: APP_DIR }])

  await run($, `link ${B} Kitchen plan`)
  await $.classic.SessionStart({ source: 'clear' })
  expect(await run($, 'unlink')).toContain('Which one? Run /roadmap unlink <number>.')
  expect(await run($, 'unlink 1')).toContain(CODE)
  expect(db.get(KEY)).toEqual([{ url: B, title: 'Kitchen plan', behind: 0, dir: APP_DIR }])
  await run($, 'unlink') // the only one
  expect(db.get(KEY)).toEqual([])
})

test('a session started in ~ counts each commit toward the roadmaps of the folder it ran in', async ($, on) => {
  const { db, shell } = engine(on, [APP, { ...KITCHEN, dir: KITCHEN_DIR }], { root: HOME })
  expect(await start($)).toBeUndefined()

  // The first milestone in a folder brings that folder's pointer, with the count, and nothing more.
  const first = await bash($, 'git -C ~/app commit -m x')
  expect(first).toEqual([expect.stringContaining(`Folder ~/app has a project roadmap: "App Launch Roadmap" (${A}).`)])
  expect(first?.[0]).toContain('It is 1 milestone(s) behind')
  expect(counts(db)).toEqual([1, 0])

  expect((await bash($, 'cd ~/kitchen && git commit -m y'))?.[0]).toContain('Folder ~/kitchen has a project roadmap')
  expect(counts(db)).toEqual([1, 1])
  expect((await bash($, 'R=$HOME/app; git -C "$R" commit -m z'))?.[0]).toContain(`(${A}) is 2 milestone(s) behind`)
  expect(counts(db)).toEqual([2, 1])

  // The Bash tool kept a `cd`: commands start there now.
  shell.cwd = KITCHEN_DIR
  expect(await commit($)).toContain(`(${B}) is 2 milestone(s) behind`)
  await bash($, 'cd ../app; git commit -m w')
  expect(counts(db)).toEqual([3, 2])

  // A repo without a roadmap, or no repo at all, counts toward none.
  expect(await bash($, 'git -C ~/other commit -m v && cd /tmp && git commit -m u')).toBeUndefined()
  expect(counts(db)).toEqual([3, 2])
})

test('the deepest roadmap folder wins, and a file tool brings its pointer once', async ($, on) => {
  const { db } = engine(on, [APP, { url: C, behind: 0, dir: `${APP_DIR}/web` }], { root: HOME })
  await start($)

  expect((await $.tool.call({ tool: 'Read', file_path: `${APP_DIR}/web/src/main.ts` })).context).toEqual([
    `Folder ~/app/web has a project roadmap: ${C}. When work there finishes a step, lands a decision or changes the plan, update it with the project-roadmap skill. Write the roadmap's text for a reader who never saw this work: name each thing in words, not by a code, id or shorthand.`,
  ])
  expect((await $.tool.call({ tool: 'Read', file_path: `${APP_DIR}/web/index.html` })).context).toBeUndefined()

  await bash($, 'git -C ~/app/web commit -m x')
  expect(counts(db)).toEqual([0, 1])
  const edit = await $.tool.call({ tool: 'Edit', file_path: `${APP_DIR}/docs/notes.md`, old_string: 'a', new_string: 'b' })
  expect(edit.context?.[0]).toContain('Folder ~/app has a project roadmap')
  await bash($, 'git -C ~/app commit -m y')
  expect(counts(db)).toEqual([1, 1])
})

test('a new roadmap covers the repo the session last worked in, past the skill files; /roadmap link moves it', async ($, on) => {
  const { db, toasts } = engine(on, undefined, { root: HOME })
  await start($)

  // The agent works in the kitchen repo, reads the router's notes and the skill's example, and writes the page in its
  // scratchpad. The notes are in ~/.claude, though they land in the skills library's repo.
  await $.tool.call({ tool: 'Read', file_path: `${KITCHEN_DIR}/plan.md` })
  await $.tool.call({ tool: 'Read', file_path: `${HOME}/.claude/skills/using-agent-skills/reference/product-management.md` })
  await $.tool.call({ tool: 'Read', file_path: `${HOME}/.agents/skills/project-roadmap/assets/example-roadmap.json` })
  await $.tool.call({ tool: 'Write', file_path: '/tmp/scratch/kitchen-roadmap.html', content: '' })
  const added = await $.tool.call({ tool: 'Artifact', file_path: '/tmp/scratch/kitchen-roadmap.html', icon: 'map' })
  expect(toasts).toEqual(['Roadmap added for ~/kitchen: Kitchen & Bath Roadmap'])
  expect(added.context?.[0]).toContain(`/roadmap link ${B} <folder>`)
  await bash($, 'git -C ~/kitchen commit -m x')
  expect(db.get(KEY)).toEqual([{ ...KITCHEN, behind: 1, dir: KITCHEN_DIR }])

  // Filed under the wrong folder, it moves with its count.
  expect(await run($, `link ${B} ~/app`)).toBe(
    `Roadmap "Kitchen & Bath Roadmap" (${B}) covers ~/app. This session works on it there.`,
  )
  expect(db.get(KEY)).toEqual([{ ...KITCHEN, behind: 1 }])
  await bash($, 'git -C ~/kitchen commit -m y')
  expect(counts(db)).toEqual([1])
  await bash($, 'git -C ~/app commit -m z')
  expect(counts(db)).toEqual([2])
})

test('a roadmap filed in no repo, like ~, counts only the work outside the repos under it', async ($, on) => {
  const { db, toasts, shell } = engine(on, undefined, { root: HOME })
  await start($)

  // Published before the agent worked in a repo, it covers the session's folder, and says what that means.
  const added = await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', icon: 'map' })
  expect(toasts).toEqual(['Roadmap added for ~: App Launch Roadmap'])
  expect(added.context?.[0]).toContain("~ is in no repo, so the repos under it don't count toward it.")

  // A repo under it brings no pointer and counts toward nothing here, with a roadmap of its own or without.
  expect(await bash($, 'git -C ~/other commit -m x')).toBeUndefined()
  expect(await bash($, 'cd ~/app && git commit -m y')).toBeUndefined()
  expect(counts(db)).toEqual([0])
  expect((await bash($, 'cd ~/notes && bd close n-1'))?.[0]).toContain('is 1 milestone(s) behind')
  expect(counts(db)).toEqual([1])

  shell.cwd = `${HOME}/other`
  expect((await $.classic.SessionStart({ source: 'clear' })).additionalContext).toBeUndefined()
  shell.cwd = HOME
  expect((await $.classic.SessionStart({ source: 'clear' })).additionalContext?.[0]).toContain('Folder ~ has a project roadmap')
})

test("a worktree inside a repo counts toward the repo's roadmaps", async ($, on) => {
  const { db, shell } = engine(on, [APP])
  await start($)

  await $.tool.call({ tool: 'Bash', command: `cd ${WORKTREE} && git commit -m x`, agentId: 'a1' })
  expect(counts(db)).toEqual([1])
  shell.cwd = WORKTREE
  expect((await $.classic.SessionStart({ source: 'clear' })).additionalContext?.[0]).toContain('Folder ~/app has a project roadmap')
})

test('a folder reached through a symbolic link counts as the folder it lands in', async ($, on) => {
  const { db, toasts } = engine(on, undefined, { root: HOME })
  await start($)

  await $.tool.call({ tool: 'Read', file_path: `${HOME}/repos/tool/plan.md` })
  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', icon: 'map' })
  expect(toasts).toEqual(['Roadmap added for ~/.repos/tool: App Launch Roadmap'])
  await bash($, 'cd ~/repos/tool && git commit -m x')
  await bash($, 'git -C ~/.repos/tool commit -m y')
  await bash($, 'cd ~/repos/tool && git commit -C HEAD') // a folder that isn't there lands where its parent does
  expect(counts(db)).toEqual([3])

  // Linked by the link's path, it covers the same folder.
  expect(await run($, `link ${A} ~/repos/tool`)).toBe(
    `Roadmap "App Launch Roadmap" (${A}) covers ~/.repos/tool. This session works on it there.`,
  )
  expect(db.get(KEY)).toEqual([{ ...APP, behind: 3, dir: TOOL_DIR }])
})

test('redirections, pipes, line continuations and subshells keep each commit with its folder', async ($, on) => {
  const { db, status } = engine(on, [APP, { ...KITCHEN, dir: KITCHEN_DIR }], { root: KITCHEN_DIR })
  await start($)

  // A redirection, or a pipe's later stage, runs with the command before it, so the agent stays in ~/app.
  await bash($, 'git -C ~/app commit -m x 2>&1 | tail -3')
  expect(status.at(-1)).toBe('roadmap: 1 behind')
  await bash($, 'git -C ~/app commit -m y &>/dev/null')
  expect(status.at(-1)).toBe('roadmap: 2 behind')
  expect(counts(db)).toEqual([2, 0])

  await bash($, 'git -C ~/app \\\n  commit -m z')
  expect(counts(db)).toEqual([3, 0])
  // A subshell's `cd` ends with it: not at a bracket inside it, and not past a redirection after it.
  await bash($, '(cd ~/app && git pull) && git commit -m w')
  expect(counts(db)).toEqual([3, 1])
  await bash($, '(cd ~/app && make) 2>&1 | tail -3; git commit -m v')
  expect(counts(db)).toEqual([3, 2])
  await bash($, '(cd ~/app && echo $(pwd) && git commit -m u)')
  expect(counts(db)).toEqual([4, 2])

  // A pipe's later stage commits where it runs, and `|&` is a pipe too.
  await bash($, 'git -C ~/app log -1 --format=%B | git commit -F -')
  expect(counts(db)).toEqual([4, 3])
  await bash($, 'git -C ~/app commit -m t |& tail -3')
  expect(status.at(-1)).toBe('roadmap: 5 behind')
})

test("a roadmap the session moved off doesn't nudge it when another session's milestones grow it", async ($, on) => {
  const { db } = engine(on, [APP, KITCHEN])
  await start($)

  await commit($) // toward both: no pick yet
  await run($, 'use 2')
  db.set(KEY, [{ ...APP, behind: 5 }, { ...KITCHEN, behind: 1 }])
  expect(await bash($, 'ls')).toBeUndefined()
  expect((await $.classic.UserPromptSubmit({ prompt: 'next?' })).additionalContext).toBeUndefined()
  db.set(KEY, [{ ...APP, behind: 5 }, { ...KITCHEN, behind: 2 }])
  expect(await bash($, 'ls')).toEqual([expect.stringContaining(`(${B}) is 2 milestone(s) behind`)])
})

const NOW = Date.parse('2026-11-05T20:00:00.000Z')
const iso = (ms: number) => new Date(ms).toISOString()
// A page's agent rows, by id.
const agentsOn = (pages: Map<string, Map<string, { data: object }>>, url: string) =>
  Object.fromEntries([...(pages.get(url) ?? [])].map(([id, r]) => [id, r.data]))
const turn = ($: Engine, agentId?: string) => $.turn.start({ text: 'go', turnId: 't', agentId })
const done = ($: Engine, agentId?: string) =>
  $.turn.complete({ answer: 'ok', durationMs: 5, isAborted: false, turnId: 't', agentId, reason: 'answer' })

test('a session at work shows on its roadmap page in a free color and name, at the step it marked, for its turns', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { db, pages } = engine(on, [APP])
  pages.set(
    A,
    new Map([
      ['other', { data: { name: 'app', color: 1, step: 'p1-1', seen: iso(NOW - 5 * 60_000) }, version: 4 }],
      ['gone', { data: { name: 'app 3', color: 2, step: null, seen: iso(NOW - 2 * 3_600_000) }, version: 9 }],
    ]),
  )
  await start($)
  await turn($)
  await commit($)
  await clock.settle()
  // Another live session there holds the first color and the plain name; one not seen for hours holds nothing.
  expect(agentsOn(pages, A).me1).toEqual({ name: 'app 2', color: 2, step: null, seen: iso(NOW) })
  expect(counts(db)).toEqual([1]) // the mod's own row writes are no work on the roadmap

  const step = (doc_id: string, status: string) =>
    $.tool.call({
      tool: 'ArtifactData',
      action: 'batch',
      url: A,
      writes: [{ op: 'update', collection: 'steps', doc_id, data: { status }, if_version: 1 }],
    })
  await step('p1-2', 'active')
  await clock.settle()
  expect(agentsOn(pages, A).me1).toMatchObject({ step: 'p1-2' })
  // The row goes with the turn, and the next turn's first tool call brings it back at its step.
  await done($)
  expect(Object.keys(agentsOn(pages, A))).toEqual(['other', 'gone'])
  await turn($)
  await bash($, 'ls')
  await clock.settle()
  expect(agentsOn(pages, A).me1).toMatchObject({ step: 'p1-2' })
  await step('p1-3', 'done') // another step: the session's stays
  await step('p1-2', 'done')
  await clock.settle()
  expect(agentsOn(pages, A).me1).toMatchObject({ step: null })

  // A row says it is still there once per ten minutes of work.
  await clock.advance(9 * 60_000)
  await bash($, 'ls')
  await clock.settle()
  expect(agentsOn(pages, A).me1).toMatchObject({ seen: iso(NOW) })
  await clock.advance(2 * 60_000)
  await bash($, 'ls')
  await clock.settle()
  expect(agentsOn(pages, A).me1).toMatchObject({ seen: iso(NOW + 11 * 60_000) })

  // The mod OKs only its own writes: another caller's write to the rows keeps the engine's ask.
  const input = { action: 'set', url: A, collection: 'agents', doc_id: 'x', data: {} }
  expect((await $.tool.check({ tool: 'ArtifactData', input })).decision).toBe('ask')

  await done($)
  expect(Object.keys(agentsOn(pages, A))).toEqual(['other', 'gone'])
})

test("a helper shows in its parent's color until its turn ends; with two roadmaps the row waits for the pick, then moves with it", async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { pages } = engine(on, [APP, KITCHEN])
  await start($)
  await turn($)
  await bash($, 'ls')
  await clock.settle()
  expect([agentsOn(pages, A), agentsOn(pages, B)]).toEqual([{}, {}]) // which one is the session's isn't known yet

  // Starting a step of the kitchen roadmap makes it the session's: the row shows there, at that step.
  await $.tool.call({ tool: 'ArtifactData', action: 'update', url: B, collection: 'steps', doc_id: 'k-1', data: { status: 'active' }, if_version: 2 })
  await clock.settle()
  expect(agentsOn(pages, B)).toEqual({ me1: { name: 'app', color: 1, step: 'k-1', seen: iso(NOW) } })

  await $.tool.call({ tool: 'Read', file_path: `${APP_DIR}/src/app.ts`, agentId: 'a1' })
  await clock.settle()
  expect(agentsOn(pages, B)['me1~a1']).toEqual({ name: 'code-reviewer', color: 1, parent: 'me1', seen: iso(NOW) })
  await done($, 'a1')
  expect(Object.keys(agentsOn(pages, B))).toEqual(['me1'])

  await run($, 'use 1')
  await bash($, 'ls')
  await clock.settle()
  expect(agentsOn(pages, B)).toEqual({})
  expect(agentsOn(pages, A)).toEqual({ me1: { name: 'app', color: 1, step: null, seen: iso(NOW) } })

  // A helper still at work when the main loop's turn ends keeps the session's row until it ends too.
  await $.tool.call({ tool: 'Read', file_path: `${APP_DIR}/src/app.ts`, agentId: 'a1' })
  await done($)
  expect(Object.keys(agentsOn(pages, A))).toEqual(['me1', 'me1~a1'])
  await done($, 'a1')
  expect(agentsOn(pages, A)).toEqual({})
})

test('a session started in ~ shows on the roadmap its helpers work on', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { pages } = engine(on, [APP], { root: HOME })
  await start($)
  await $.tool.call({ tool: 'Read', file_path: `${APP_DIR}/README.md`, agentId: 'a1' })
  // A loop the engine runs for itself, which the agent list doesn't name, gets no row and holds none up.
  await $.tool.call({ tool: 'Read', file_path: `${APP_DIR}/README.md`, agentId: 'memory-1' })
  await clock.settle()
  expect(Object.keys(agentsOn(pages, A))).toEqual(['me1', 'me1~a1'])
  await done($, 'a1')
  expect(agentsOn(pages, A)).toEqual({})
})

test('without the ArtifactData tool, as under claude -p, the rows try once a turn and the counts go on', async ($, on) => {
  const clock = mock.clock(on, { now: NOW })
  const { db, tries } = engine(on, [APP], { data: false })
  await start($)
  await turn($)
  for (let i = 0; i < 3; i++) await bash($, 'ls')
  await commit($)
  await clock.settle()
  expect(tries()).toBe(1)
  expect(counts(db)).toEqual([1])
  await done($)
  await turn($)
  await bash($, 'ls')
  await clock.settle()
  expect(tries()).toBe(2)
})
