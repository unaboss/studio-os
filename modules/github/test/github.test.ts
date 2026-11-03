import { describe, expect, it } from 'vitest'
import projects from '@studio-os/module-projects'
import money from '@studio-os/module-money'
import people from '@studio-os/module-people'
import github, { GITHUB, handleGithubEvent, referencedIssues, suggestHours, type GithubService } from '@studio-os/module-github'
import { testStudio } from '@studio-os/testing'

const REPO = 'northtech/karoo-app'

function fakeGithub()
{
    const calls: string[] = []
    let next = 100
    const svc: GithubService = {
        async createIssue(repo, i) { calls.push(`issue ${repo} ${i.title}`); next++; return { number: next, url: `https://github.com/${repo}/issues/${next}` } },
        async setIssueState(repo, n, state) { calls.push(`issue ${n} ${state}`) },
        async createMilestone(repo, m) { calls.push(`milestone ${m.title}`); next++; return { number: next } },
        async setMilestoneState(repo, n, state) { calls.push(`milestone ${n} ${state}`) },
        async listIssues() { return [{ number: 7, title: 'Imported issue', state: 'open', url: 'https://github.com/x/7', milestone: null, assignee: 'lerato-codes' }] },
        async listMilestones() { return [] },
    }
    return { svc, calls }
}

async function setup()
{
    const s = await testStudio([projects, money, people, github])
    const gh = fakeGithub()
    s.services.github = gh.svc
    const m = s.as(s.manager)
    const client = await m.records.create({ type: 'client', title: 'Karoo Coffee' })
    const out = await m.actions.request('project.start', { clientId: client.id, title: 'Ordering app', projectType: 'small', valueCents: 2_000_000, repo: REPO })
    if (out.status !== 'done') throw new Error('expected done')
    const projectId = String(out.result.projectId)
    await m.records.update(projectId, { data: { members: [s.manager.id, s.employee.id] } })
    return { s, m, gh, projectId, phaseIds: out.result.phaseIds as string[], hook: s.as(GITHUB) }
}

describe('parsing', () => {
    it('finds issue references and closing keywords', () => {
        expect(referencedIssues('Fix login. Closes #12, relates to #4 and fixes #9')).toEqual({ mentions: [12, 4, 9], closes: [12, 9] })
        expect(referencedIssues('see a&#39;b')).toEqual({ mentions: [], closes: [] })
    })

    it('suggests hours from a span of commits', () => {
        expect(suggestHours(['2026-11-03T09:00:00+02:00', '2026-11-03T11:10:00+02:00'])).toBe(3)
        expect(suggestHours(['2026-11-03T09:00:00+02:00'])).toBe(1)
        expect(suggestHours(['2026-11-03T01:00:00Z', '2026-11-03T20:00:00Z'])).toBe(8)
    })
})

describe('Studio OS to GitHub', () => {
    it('creates milestones for phases and issues for tasks', async () => {
        const { m, gh, projectId, phaseIds } = await setup()
        expect(gh.calls).toEqual(['milestone Deposit and build', 'milestone Delivery'])
        const phase = await m.records.get(phaseIds[0]!)
        const task = await m.records.create({ type: 'task', title: 'Menu screen', parentId: projectId, data: { phase: phase.id, assignee: 'usr_lerato' } })
        expect(gh.calls.at(-1)).toBe(`issue ${REPO} Menu screen`)
        expect((await m.records.get(task.id)).data.issue).toBe(103)
        await m.actions.request('task.move', { taskId: task.id, status: 'Done' })
        expect(gh.calls).toContain('issue 103 closed')
        expect(gh.calls).toContain(`milestone ${phase.data.milestone} closed`)
    })
})

describe('GitHub to Studio OS', () => {
    it('turns issues into tasks and assigns them by GitHub login', async () => {
        const { s, gh, hook, projectId } = await setup()
        const before = gh.calls.length
        await handleGithubEvent(hook, 'issues', {
            action: 'opened',
            repository: { full_name: REPO },
            issue: { number: 5, title: 'Payment page', state: 'open', html_url: 'https://github.com/x/5', assignee: { login: 'Lerato-Codes' }, milestone: null },
        })
        const e = s.as(s.employee)
        const [task] = await e.records.list('task', { parentId: projectId })
        expect(task).toMatchObject({ title: 'Payment page', status: 'To do', data: { issue: 5, assignee: s.employee.id } })
        expect(gh.calls.length).toBe(before)
    })

    it('moves tasks through review to done from pull requests, and bills the milestone', async () => {
        const { s, m, gh, hook, projectId, phaseIds } = await setup()
        const phase = await m.records.get(phaseIds[0]!)
        await handleGithubEvent(hook, 'issues', {
            action: 'opened',
            repository: { full_name: REPO },
            issue: { number: 5, title: 'Payment page', state: 'open', html_url: 'https://github.com/x/5', assignee: null, milestone: { number: phase.data.milestone } },
        })
        const pr = { number: 6, title: 'Payment page', body: 'Closes #5', html_url: 'https://github.com/x/pull/6', draft: false, user: { login: 'thabo-dev' }, merged: false }
        await handleGithubEvent(hook, 'pull_request', { action: 'opened', repository: { full_name: REPO }, pull_request: pr })
        const [task] = await m.records.list('task', { parentId: projectId })
        expect(task!.status).toBe('In review')

        await handleGithubEvent(hook, 'pull_request', { action: 'review_requested', repository: { full_name: REPO }, pull_request: pr, requested_reviewer: { login: 'lerato-codes' } })
        const e = s.as(s.employee)
        const tile = await e.registry.tiles('employee').find((t) => t.id === 'github.my_reviews')!.load(e)
        expect(tile.value).toBe('1')

        const callsBefore = gh.calls.length
        await handleGithubEvent(hook, 'pull_request', { action: 'closed', repository: { full_name: REPO }, pull_request: { ...pr, merged: true } })
        expect((await m.records.get(task!.id)).status).toBe('Done')
        expect((await m.records.get(phase.id)).status).toBe('Done')
        const invoices = await m.records.list('invoice', { parentId: projectId })
        expect(invoices.map((i) => i.data.amount)).toEqual([1_000_000])
        expect(gh.calls.length).toBe(callsBefore)
        const after = await e.registry.tiles('employee').find((t) => t.id === 'github.my_reviews')!.load(e)
        expect(after.value).toBe('0')
    })

    it('suggests time from commits for the person to confirm', async () => {
        const { s, hook } = await setup()
        await handleGithubEvent(hook, 'push', {
            ref: 'refs/heads/main',
            repository: { full_name: REPO },
            commits: [
                { id: 'a1', message: 'Add menu', timestamp: '2026-11-03T09:00:00+02:00', author: { username: 'lerato-codes' } },
                { id: 'a2', message: 'Fix totals\n\nlong body', timestamp: '2026-11-03T10:30:00+02:00', author: { username: 'lerato-codes' } },
                { id: 'a3', message: 'Someone else', timestamp: '2026-11-03T10:30:00+02:00', author: { username: 'stranger' } },
            ],
        })
        await handleGithubEvent(hook, 'push', {
            ref: 'refs/heads/main',
            repository: { full_name: REPO },
            commits: [{ id: 'a4', message: 'Polish', timestamp: '2026-11-03T13:00:00+02:00', author: { username: 'lerato-codes' } }],
        })
        const e = s.as(s.employee)
        const entries = await e.records.list('time', { status: 'Suggested' })
        expect(entries).toHaveLength(1)
        expect(entries[0]!.data.hours).toBe(5)
        expect(entries[0]!.data.note).toBe('• Add menu\n• Fix totals\n• Polish')
    })

    it('ignores repos that are not linked to a project', async () => {
        const { hook } = await setup()
        expect(await handleGithubEvent(hook, 'issues', { action: 'opened', repository: { full_name: 'someone/else' }, issue: {} })).toMatch(/^ignored/)
    })

    it('imports a repo', async () => {
        const { m, projectId } = await setup()
        const out = await m.actions.request('github.import_repo', { projectId })
        expect(out).toMatchObject({ result: { tasks: 1 } })
    })
})
