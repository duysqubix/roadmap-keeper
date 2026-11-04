import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// A publish prints the short form; a pasted link may be the code/ form, a different id.
const A = 'https://claude.ai/artifact/RoadmapA1'
const B = 'https://claude.ai/artifact/RoadmapB2'
const C = 'https://claude.ai/artifact/RoadmapC3'
const OTHER = 'https://claude.ai/artifact/WellsMap9'
const CODE = 'https://claude.ai/code/artifact/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab'
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
const APP = { url: A, title: 'App Launch Roadmap', behind: 0 }
const KITCHEN = { url: B, title: 'Kitchen & Bath Roadmap', behind: 0 }
const KEY = 'roadmaps:/work/app'
const OLD = 'link:/work/app' // where the first version kept its one link

// Stands for the engine: a store in memory holding `roadmaps` under `key`, every tool answers,
// a publish prints its page's URL, a file outside FILES is missing, and a Bash command naming FAILS fails.
const engine = (on: On, roadmaps?: unknown, key = KEY) => {
  const db = new Map<string, unknown>(roadmaps === undefined ? [] : [[key, roadmaps]])
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  on('store.get', (_, e) => ({ value: db.get(e.key) }))
  on('store.set', (_, e) => ({ value: void db.set(e.key, e.value) }))
  on('fs.read', (_, e) => {
    const text = FILES[e.path.split('/').pop() ?? ''] // the engine hands the hook an absolute path
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('ui.status', (_, e) => ({ value: void status.push(e.text) }))
  on('ui.toast', (_, e) => ({ value: void toasts.push(e.text) }))
  on('session.root', () => ({ value: '/work/app' }))
  on('command.register', () => ({ value: { command: 'roadmap' } }))
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('classic.SessionStart', () => ({}))
  on('classic.UserPromptSubmit', () => ({}))
  on('tool.call', (_, e) => {
    if (e.tool === 'Artifact') return { result: {}, text: `Published at ${PAGES[e.file_path ?? ''] ?? OTHER}` }
    if (e.tool === 'Bash' && e.command.includes('FAILS')) return { result: {}, isError: true }
    return { result: {} }
  })
  return { db, status, toasts }
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
const start = ($: Engine) =>
  $.session.start({ cwd: '/work/app/web', surface: 'terminal', isInteractive: true })
const counts = (db: Map<string, unknown>) => (db.get(KEY) as { behind: number }[] | undefined)?.map(r => r.behind)
// A commit in the main loop, and the nudge it brought, if any.
const commit = async ($: Engine) => (await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })).context?.[0]

test('a roadmap publish adds it by its title, a commit nudges once, a db write syncs it', async ($, on) => {
  const { db, status, toasts } = engine(on)
  await start($)

  expect((await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', icon: 'map' })).context).toBeUndefined()
  expect(db.get(KEY)).toEqual([APP])
  expect(toasts).toEqual(['Roadmap added: App Launch Roadmap'])

  const nudge = await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "ship"' })
  expect(nudge.context?.[0]).toContain(`"App Launch Roadmap" (${A}) is 1 milestone(s) behind`)
  expect(status.at(-1)).toBe('roadmap: 1 behind')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined()

  await $.tool.call({ tool: 'ArtifactData', action: 'batch', url: A, writes: [] })
  expect(db.get(KEY)).toEqual([APP])
  expect(status.at(-1)).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'gh pr merge 12' })).context?.[0]).toContain('1 milestone(s)')
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
  expect(db.get(KEY)).toEqual([APP, KITCHEN, { url: C, behind: 0 }])
  expect(toasts).toEqual([
    'Roadmap added: App Launch Roadmap',
    'Roadmap added: Kitchen & Bath Roadmap',
    `Roadmap added: ${C}`,
  ])
})

test('only real milestones count, and only writes to a linked roadmap sync it', async ($, on) => {
  const { db } = engine(on, [{ url: A, behind: 0 }])
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

test("the first version's link loads and stays for sessions still on it; a code/ form link syncs by its url", async ($, on) => {
  const { db } = engine(on, { url: CODE, behind: 2 }, OLD)
  await start($)

  expect(await run($, '')).toContain(`1. ${CODE}, 2 behind`)
  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', url: CODE })
  expect(db.get(KEY)).toEqual([APP])
  expect(db.get(OLD)).toEqual({ url: CODE, behind: 2 })

  // Emptied, the list stays empty: the old link doesn't come back.
  await run($, 'unlink')
  expect(await run($, '')).toContain('No roadmap linked to /work/app')
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
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined()
})

test('a sync from another session re-arms the nudge', async ($, on) => {
  const { db } = engine(on, [APP])
  await start($)

  expect(await commit($)).toContain(A)
  db.set(KEY, [APP])
  expect(await commit($)).toContain('1 milestone(s)')
})

test('with two roadmaps, milestones count toward both until the session works on one', async ($, on) => {
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
  expect(await run($, '')).toContain(`2. "Kitchen & Bath Roadmap" (${B}), 1 behind (this session)`)

  expect(await run($, 'use 1')).toBe(`This session works on "App Launch Roadmap" (${A}).`)
  expect(await commit($)).toContain(`"App Launch Roadmap" (${A}) is 2 milestone(s) behind`)
  expect(counts(db)).toEqual([2, 1])
  expect(status.at(-1)).toBe('roadmap: 2 behind')

  // Linking a listed page again renames it and keeps its count.
  await run($, `link ${A} App launch`)
  expect(db.get(KEY)).toEqual([{ ...APP, title: 'App launch', behind: 2 }, { ...KITCHEN, behind: 1 }])
  expect(status.at(-1)).toBe('roadmap: 2 behind')
})

test('the pointer lists every roadmap; only a compaction keeps the session on its pick', async ($, on) => {
  const { status } = engine(on, [{ ...APP, behind: 1 }, KITCHEN])
  await start($)
  const pointer = async (source: 'startup' | 'compact' | 'clear') =>
    (await $.classic.SessionStart({ source })).additionalContext?.[0]

  const fresh = await pointer('startup')
  expect(fresh).toContain(
    `This folder has 2 project roadmaps, one per effort: 1. "App Launch Roadmap" (${A}), 1 behind; 2. "Kitchen & Bath Roadmap" (${B}), 0 behind.`,
  )
  expect(fresh).toContain('until then, milestones count toward all of them')

  await run($, 'use 2')
  expect(status.at(-1)).toBeUndefined()
  expect(await pointer('compact')).toContain(`This session works on "Kitchen & Bath Roadmap" (${B}).`)
  expect(await pointer('clear')).toContain('until then, milestones count toward all of them')
  // Without a pick, the status line shows the furthest behind again.
  expect(status.at(-1)).toBe('roadmap: 1 behind')
})

test('a republish that turns a code/ link into a listed url keeps one entry; a malformed entry is dropped', async ($, on) => {
  const { db } = engine(on, [
    { url: CODE, behind: 2 },
    { ...APP, behind: 1 },
    { title: 'no url', behind: 1 },
    { url: OTHER, behind: null },
  ])
  await start($)

  expect(await run($, '')).toBe(
    `Roadmaps for /work/app:\n1. ${CODE}, 2 behind\n2. "App Launch Roadmap" (${A}), 1 behind`,
  )
  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', url: CODE })
  expect(db.get(KEY)).toEqual([APP])
})

test("/roadmap links with a title, and unlinks the one named, else the session's or the only one", async ($, on) => {
  const { db } = engine(on)
  await start($)

  expect(await run($, '')).toContain('No roadmap linked to /work/app')
  expect(await run($, `link ${CODE}`)).toContain('Roadmap linked to /work/app')
  expect(await run($, `link ${B} Kitchen plan`)).toContain('"Kitchen plan"')
  expect(db.get(KEY)).toEqual([{ url: CODE, behind: 0 }, { url: B, title: 'Kitchen plan', behind: 0 }])

  await run($, 'unlink') // this session's: the one linked last
  expect(db.get(KEY)).toEqual([{ url: CODE, behind: 0 }])

  await run($, `link ${B} Kitchen plan`)
  await $.classic.SessionStart({ source: 'clear' })
  expect(await run($, 'unlink')).toContain('Which one? Run /roadmap unlink <number>.')
  expect(await run($, 'unlink 1')).toContain(CODE)
  expect(db.get(KEY)).toEqual([{ url: B, title: 'Kitchen plan', behind: 0 }])
  await run($, 'unlink') // the only one
  expect(db.get(KEY)).toEqual([])
})
