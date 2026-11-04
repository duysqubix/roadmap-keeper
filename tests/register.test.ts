import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

// A publish prints the short form; a pasted link may be the code/ form, a different id.
const A = 'https://claude.ai/artifact/RoadmapA1'
const B = 'https://claude.ai/artifact/RoadmapB2'
const OTHER = 'https://claude.ai/artifact/WellsMap9'
const CODE = 'https://claude.ai/code/artifact/0b1c2d3e-aaaa-bbbb-cccc-1234567890ab'
const PAGES: Record<string, string> = { 'roadmap.html': A, 'kitchen-roadmap.html': B, 'wells.html': OTHER }
const KEY = 'link:/work/app'

// Stands for the engine: a store in memory, every tool answers, a publish prints its page's URL,
// and a Bash command naming FAILS fails.
const engine = (on: On, seed: Record<string, unknown> = {}) => {
  const db = new Map(Object.entries(seed))
  const status: (string | undefined)[] = []
  const toasts: string[] = []
  on('store.get', (_, e) => ({ value: db.get(e.key) }))
  on('store.set', (_, e) => ({ value: void db.set(e.key, e.value) }))
  on('store.delete', (_, e) => ({ value: void db.delete(e.key) }))
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
const run = ($: Engine, args: string) =>
  $.command.run({ command: 'roadmap', args, origin: { kind: 'composer' }, presentation: { isFullscreen: false, columns: 100 } })
const start = ($: Engine) =>
  $.session.start({ cwd: '/work/app/web', surface: 'terminal', isInteractive: true })
const behind = (db: Map<string, unknown>) => (db.get(KEY) as { behind: number } | undefined)?.behind

test('a roadmap publish links the root, a commit nudges once, a db write syncs it', async ($, on) => {
  const { db, status } = engine(on)
  await start($)

  expect((await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', icon: 'map' })).context).toBeUndefined()
  expect(db.get(KEY)).toEqual({ url: A, behind: 0 })

  const commit = await $.tool.call({ tool: 'Bash', command: 'git add -A && git commit -m "ship"' })
  expect(commit.context?.[0]).toContain('1 milestone(s) behind')
  expect(status.at(-1)).toBe('roadmap: 1 behind')
  expect((await $.tool.call({ tool: 'Bash', command: 'ls' })).context).toBeUndefined()

  await $.tool.call({ tool: 'ArtifactData', action: 'batch', url: A, writes: [] })
  expect(db.get(KEY)).toEqual({ url: A, behind: 0 })
  expect(status.at(-1)).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'gh pr merge 12' })).context?.[0]).toContain('1 milestone(s)')
})

test('only a roadmap page with the map icon links; other map pages leave the link alone', async ($, on) => {
  const { db, toasts } = engine(on)
  await start($)

  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', icon: 'chart' })
  await $.tool.call({ tool: 'Artifact', file_path: 'wells.html', icon: 'map' })
  expect(db.get(KEY)).toBeUndefined()
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m x' })).context).toBeUndefined()
  expect((await $.classic.SessionStart({ source: 'startup' })).additionalContext).toBeUndefined()

  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', icon: 'map' })
  await $.tool.call({ tool: 'Artifact', file_path: 'wells.html', icon: 'map' })
  expect(db.get(KEY)).toEqual({ url: A, behind: 0 })
  expect(toasts).toEqual([])

  await $.tool.call({ tool: 'Artifact', file_path: 'kitchen-roadmap.html', icon: 'map' })
  expect(db.get(KEY)).toEqual({ url: B, behind: 0 })
  expect(toasts).toEqual([`Roadmap link moved to ${B}`])
})

test('only real milestones count, and only writes to the linked roadmap sync it', async ($, on) => {
  const { db } = engine(on, { [KEY]: { url: A, behind: 0 } })
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
    expect([command, behind(db)]).toEqual([command, count])
  }

  await $.tool.call({ tool: 'ArtifactData', action: 'get', url: A, collection: 'meta', doc_id: 'summary' })
  await $.tool.call({ tool: 'ArtifactData', action: 'list', url: A, collection: 'steps' })
  await $.tool.call({ tool: 'ArtifactData', action: 'update', url: OTHER, collection: 'steps', doc_id: 'p1-1', data: {} })
  await $.tool.call({ tool: 'Artifact', action: 'publish', asset: true, url: OTHER, from_url: A, asset_ids: [] })
  expect(behind(db)).toBe(3)

  // A static roadmap syncs by republishing the page: no icon this time.
  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html' })
  expect(db.get(KEY)).toEqual({ url: A, behind: 0 })
})

test('a link pasted in the code/ form syncs on a republish by its url', async ($, on) => {
  const { db } = engine(on, { [KEY]: { url: CODE, behind: 2 } })
  await start($)

  await $.tool.call({ tool: 'Artifact', file_path: 'roadmap.html', url: CODE })
  expect(db.get(KEY)).toEqual({ url: A, behind: 0 })
})

test("a subagent's milestone reaches the main loop once: at the next prompt, or by the pointer", async ($, on) => {
  engine(on, { [KEY]: { url: A, behind: 0 } })
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
  const { db } = engine(on, { [KEY]: { url: A, behind: 0 } })
  await start($)

  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m a' })).context?.[0]).toContain(A)
  db.set(KEY, { url: A, behind: 0 })
  expect((await $.tool.call({ tool: 'Bash', command: 'git commit -m b' })).context?.[0]).toContain('1 milestone(s)')
})

test('/roadmap links, shows and unlinks', async ($, on) => {
  const { db } = engine(on)
  await start($)

  expect(JSON.stringify(await run($, `link ${CODE}`))).toContain('Roadmap linked to /work/app')
  expect(db.get(KEY)).toEqual({ url: CODE, behind: 0 })
  expect(JSON.stringify(await run($, ''))).toContain(CODE)
  await run($, 'unlink')
  expect(db.get(KEY)).toBeUndefined()
})
