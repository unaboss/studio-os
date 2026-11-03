import { defineModule, type Actor, type Ctx, type StoredRecord, type TileData } from '@studio-os/core'

/** Who changes things when the change came from GitHub. Used to stop echo loops. */
export const GITHUB: Actor = { id: 'github', kind: 'system', role: 'manager', name: 'GitHub' }

export interface GithubIssue
{
    readonly number: number
    readonly title: string
    readonly state: 'open' | 'closed'
    readonly url: string
    readonly milestone: number | null
    readonly assignee: string | null
    readonly isPullRequest?: boolean
}

export interface GithubMilestone
{
    readonly number: number
    readonly title: string
    readonly state: 'open' | 'closed'
    readonly dueOn: string | null
}

/** The few GitHub calls Studio OS makes. The API app implements it with a token. */
export interface GithubService
{
    createIssue(repo: string, issue: { title: string; body?: string; milestone?: number; assignees?: string[] }): Promise<{ number: number; url: string }>
    setIssueState(repo: string, number: number, state: 'open' | 'closed'): Promise<void>
    createMilestone(repo: string, milestone: { title: string; dueOn?: string }): Promise<{ number: number }>
    setMilestoneState(repo: string, number: number, state: 'open' | 'closed'): Promise<void>
    listIssues(repo: string): Promise<GithubIssue[]>
    listMilestones(repo: string): Promise<GithubMilestone[]>
}

const OPEN_TASK = ['To do', 'In progress']
const CLOSES = /\b(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?)\s+#(\d+)/gi
const MENTIONS = /(?:^|[^\w&])#(\d+)\b/g

const service = (ctx: Ctx) => ctx.services.github as GithubService | undefined

export async function projectForRepo(ctx: Ctx, repo: string): Promise<StoredRecord | null>
{
    const rows = await ctx.db.query<{ id: string }>(
        `select id from records where company_id = $1 and type = 'project' and lower(data->>'repo') = lower($2)
         order by created_at desc limit 1`,
        [ctx.companyId, repo],
    )
    return rows[0] ? ctx.records.getRaw(rows[0].id) : null
}

export async function userForLogin(ctx: Ctx, login: string | null | undefined): Promise<string | null>
{
    if (!login) return null
    const rows = await ctx.db.query<{ id: string }>(
        'select id from users where company_id = $1 and lower(github_login) = lower($2) and active',
        [ctx.companyId, login],
    )
    return rows[0]?.id ?? null
}

async function loginForUser(ctx: Ctx, userId: unknown): Promise<string | null>
{
    if (typeof userId !== 'string') return null
    const rows = await ctx.db.query<{ github_login: string | null }>('select github_login from users where id = $1 and company_id = $2', [userId, ctx.companyId])
    return rows[0]?.github_login ?? null
}

async function taskForIssue(ctx: Ctx, project: StoredRecord, issue: number): Promise<StoredRecord | null>
{
    const found = await ctx.records.list('task', { parentId: project.id, where: { issue }, limit: 1 })
    return found[0] ?? null
}

async function phaseForMilestone(ctx: Ctx, project: StoredRecord, milestone: number | null): Promise<StoredRecord | null>
{
    if (milestone === null) return null
    const found = await ctx.records.list('phase', { parentId: project.id, where: { milestone }, limit: 1 })
    return found[0] ?? null
}

/** Issue numbers a pull request refers to, and those it will close when merged. */
export function referencedIssues(text: string): { mentions: number[]; closes: number[] }
{
    const closes = [...text.matchAll(CLOSES)].map((m) => Number(m[1]))
    const mentions = [...text.matchAll(MENTIONS)].map((m) => Number(m[1]))
    return { mentions: [...new Set([...mentions, ...closes])], closes: [...new Set(closes)] }
}

async function upsertTaskFromIssue(ctx: Ctx, project: StoredRecord, issue: GithubIssue): Promise<StoredRecord>
{
    const [task, phase, assignee] = await Promise.all([
        taskForIssue(ctx, project, issue.number),
        phaseForMilestone(ctx, project, issue.milestone),
        userForLogin(ctx, issue.assignee),
    ])
    const data: Record<string, unknown> = { issue: issue.number, url: issue.url }
    if (phase) data.phase = phase.id
    if (assignee) data.assignee = assignee
    if (!task) {
        return ctx.records.create({
            type: 'task',
            title: issue.title,
            status: issue.state === 'closed' ? 'Done' : 'To do',
            parentId: project.id,
            data,
        })
    }
    let status = task.status
    if (issue.state === 'closed') status = 'Done'
    else if (task.status === 'Done') status = 'To do'
    return ctx.records.update(task.id, { title: issue.title, status, data })
}

async function upsertPhaseFromMilestone(ctx: Ctx, project: StoredRecord, m: GithubMilestone): Promise<StoredRecord>
{
    const phases = await ctx.records.list('phase', { parentId: project.id })
    const existing = phases.find((p) => p.data.milestone === m.number) ?? phases.find((p) => p.title.toLowerCase() === m.title.toLowerCase())
    const data: Record<string, unknown> = { milestone: m.number, ...(m.dueOn ? { due: m.dueOn.slice(0, 10) } : {}) }
    if (!existing) {
        return ctx.records.create({
            type: 'phase',
            title: m.title,
            status: m.state === 'closed' ? 'Done' : 'Not started',
            parentId: project.id,
            data: { ...data, order: phases.length + 1 },
        })
    }
    const status = m.state === 'closed' ? 'Done' : existing.status === 'Done' ? 'In progress' : existing.status
    return ctx.records.update(existing.id, { status, data })
}

/** Rounds a span of commits to suggested hours: half-hour steps, 0.5 to 8. */
export function suggestHours(timestamps: readonly string[]): number
{
    const times = timestamps.map((t) => Date.parse(t)).filter(Number.isFinite).sort((a, b) => a - b)
    if (times.length === 0) return 0
    const spanHours = (times.at(-1)! - times[0]!) / 3_600_000 + 1
    return Math.min(8, Math.max(0.5, Math.round(spanHours * 2) / 2))
}

async function suggestTime(ctx: Ctx, project: StoredRecord, userId: string, date: string): Promise<void>
{
    if (!ctx.registry.hasRecordType('time')) return
    const commits = await ctx.db.query<{ payload: { ts: string; message: string } }>(
        `select payload from events where company_id = $1 and name = 'github.commit'
           and payload->>'user' = $2 and payload->>'date' = $3 and payload->>'projectId' = $4
         order by id`,
        [ctx.companyId, userId, date, project.id],
    )
    const hours = suggestHours(commits.map((c) => c.payload.ts))
    const note = commits.map((c) => `• ${String(c.payload.message).split('\n')[0]}`).slice(0, 20).join('\n')
    const existing = await ctx.records.list('time', { parentId: project.id, where: { user: userId, date, source: 'GitHub' }, limit: 1 })
    const entry = existing[0]
    if (!entry) {
        await ctx.records.create({
            type: 'time',
            title: `${project.title} · ${date}`,
            status: 'Suggested',
            parentId: project.id,
            data: { user: userId, date, hours, project: project.id, note, source: 'GitHub', billable: true },
        })
    } else if (entry.status === 'Suggested') {
        await ctx.records.update(entry.id, { data: { hours, note } })
    }
}

type Json = Record<string, any>

/**
 * Applies one GitHub webhook delivery. The API checks the signature first;
 * this only sees verified payloads. Returns what it did, for the log.
 */
export async function handleGithubEvent(ctx: Ctx, event: string, body: Json): Promise<string>
{
    const repo: string | undefined = body.repository?.full_name
    if (!repo) return 'ignored: no repository'
    const project = await projectForRepo(ctx, repo)
    if (!project) return `ignored: no project is linked to ${repo}`

    switch (event) {
        case 'issues': {
            if (body.action === 'deleted') return 'ignored: deleted issue'
            const i = body.issue
            const task = await upsertTaskFromIssue(ctx, project, {
                number: i.number,
                title: i.title,
                state: i.state,
                url: i.html_url,
                milestone: i.milestone?.number ?? null,
                assignee: i.assignee?.login ?? null,
            })
            return `task ${task.id} ${task.status}`
        }
        case 'milestone': {
            if (body.action === 'deleted') return 'ignored: deleted milestone'
            const m = body.milestone
            const phase = await upsertPhaseFromMilestone(ctx, project, { number: m.number, title: m.title, state: m.state, dueOn: m.due_on ?? null })
            return `phase ${phase.id} ${phase.status}`
        }
        case 'pull_request': {
            const pr = body.pull_request
            const refs = referencedIssues(`${pr.title ?? ''}\n${pr.body ?? ''}`)
            const done: string[] = []
            if (['opened', 'reopened', 'ready_for_review', 'edited'].includes(body.action) && !pr.draft) {
                for (const n of refs.mentions) {
                    const task = await taskForIssue(ctx, project, n)
                    if (task && OPEN_TASK.includes(task.status)) {
                        await ctx.records.update(task.id, { status: 'In review' })
                        done.push(`${task.id} in review`)
                    }
                }
            }
            if (body.action === 'review_requested' && body.requested_reviewer?.login) {
                const userId = await userForLogin(ctx, body.requested_reviewer.login)
                if (userId && ctx.registry.hasRecordType('review')) {
                    const existing = await ctx.records.list('review', { where: { user: userId, repo, pr: pr.number }, status: 'Waiting' })
                    if (existing.length === 0) {
                        await ctx.records.create({
                            type: 'review',
                            title: pr.title,
                            parentId: project.id,
                            data: { user: userId, repo, pr: pr.number, url: pr.html_url, author: pr.user?.login ?? '', project: project.id },
                        })
                        done.push(`review requested from ${userId}`)
                    }
                }
            }
            if (body.action === 'closed') {
                for (const r of await ctx.records.list('review', { where: { repo, pr: pr.number }, status: 'Waiting' })) {
                    await ctx.records.update(r.id, { status: 'Done' })
                }
                if (pr.merged) {
                    for (const n of refs.closes) {
                        const task = await taskForIssue(ctx, project, n)
                        if (task && task.status !== 'Done') {
                            await ctx.records.update(task.id, { status: 'Done' })
                            done.push(`${task.id} done`)
                        }
                    }
                    await ctx.events.emit('github.pr_merged', {
                        recordId: project.id,
                        payload: { repo, projectId: project.id, number: pr.number, title: pr.title, url: pr.html_url, author: pr.user?.login ?? '' },
                    })
                }
            }
            return done.length ? done.join(', ') : `pull request ${body.action}`
        }
        case 'pull_request_review': {
            const userId = await userForLogin(ctx, body.review?.user?.login)
            if (!userId) return 'ignored: reviewer not on the team'
            for (const r of await ctx.records.list('review', { where: { user: userId, repo, pr: body.pull_request.number }, status: 'Waiting' })) {
                await ctx.records.update(r.id, { status: 'Done' })
            }
            return 'review done'
        }
        case 'push': {
            const branch = String(body.ref ?? '').replace('refs/heads/', '')
            const seen = new Set<string>()
            for (const c of body.commits ?? []) {
                const userId = await userForLogin(ctx, c.author?.username)
                if (!userId) continue
                const date = String(c.timestamp).slice(0, 10)
                await ctx.events.emit('github.commit', {
                    recordId: project.id,
                    payload: { user: userId, date, ts: c.timestamp, projectId: project.id, message: c.message, sha: c.id, branch },
                })
                seen.add(`${userId}|${date}`)
            }
            for (const key of seen) {
                const [userId, date] = key.split('|') as [string, string]
                await suggestTime(ctx, project, userId, date)
            }
            return `${(body.commits ?? []).length} commits`
        }
        case 'workflow_run':
        case 'check_suite': {
            const run = body.workflow_run ?? body.check_suite
            if (body.action !== 'completed') return 'ignored: not completed'
            const failed = run.conclusion === 'failure' || run.conclusion === 'timed_out'
            await ctx.events.emit(failed ? 'github.checks_failed' : 'github.checks_passed', {
                recordId: project.id,
                payload: { repo, projectId: project.id, name: run.name ?? 'checks', branch: run.head_branch, url: run.html_url ?? null, conclusion: run.conclusion },
            })
            return `checks ${run.conclusion}`
        }
        case 'release': {
            if (body.action !== 'published') return 'ignored'
            await ctx.events.emit('github.release', {
                recordId: project.id,
                payload: { repo, projectId: project.id, name: body.release.name || body.release.tag_name, notes: body.release.body ?? '', url: body.release.html_url },
            })
            return 'release noted'
        }
        default:
            return `ignored: ${event}`
    }
}

const fromGithub = (actor: Actor) => actor.id === GITHUB.id

/**
 * GitHub, both ways: issues are tasks, milestones are phases, pull requests
 * move tasks to review and done, commits suggest time, and finishing a phase
 * in Studio OS closes its milestone.
 */
export default defineModule({
    id: 'github',
    name: 'GitHub',
    description: 'Two-way sync of issues, milestones, pull requests, reviews and commits.',
    dependsOn: ['projects'],
    records: [
        {
            type: 'review',
            label: 'Review request',
            plural: 'Review requests',
            parent: 'project',
            visibility: 'assigned',
            assigneeField: 'user',
            statuses: ['Waiting', 'Done'],
            fields: [
                { key: 'user', label: 'Reviewer', kind: 'user', required: true },
                { key: 'repo', label: 'Repository', kind: 'text', required: true },
                { key: 'pr', label: 'Pull request', kind: 'number', required: true },
                { key: 'url', label: 'Link', kind: 'url' },
                { key: 'author', label: 'Author', kind: 'text' },
                { key: 'project', label: 'Project', kind: 'record', recordType: 'project' },
            ],
        },
    ],
    emits: ['github.commit', 'github.pr_merged', 'github.checks_failed', 'github.checks_passed', 'github.release'],
    listens: {
        'task.created': async (ctx, event) => {
            const gh = service(ctx)
            const task = event.payload.record as StoredRecord
            if (!gh || fromGithub(event.actor) || task.data.issue || !task.parentId) return
            const project = await ctx.records.getRaw(task.parentId)
            if (!project.data.repo) return
            const phase = task.data.phase ? await ctx.records.getRaw(String(task.data.phase)) : null
            const login = await loginForUser(ctx, task.data.assignee)
            const issue = await gh.createIssue(String(project.data.repo), {
                title: task.title,
                ...(task.data.notes ? { body: String(task.data.notes) } : {}),
                ...(typeof phase?.data.milestone === 'number' ? { milestone: phase.data.milestone } : {}),
                ...(login ? { assignees: [login] } : {}),
            })
            await ctx.records.update(task.id, { data: { issue: issue.number, url: issue.url } })
        },
        'task.done': async (ctx, event) => {
            const gh = service(ctx)
            const task = event.payload.record as StoredRecord
            if (!gh || fromGithub(event.actor) || typeof task.data.issue !== 'number' || !task.parentId) return
            const project = await ctx.records.getRaw(task.parentId)
            if (project.data.repo) await gh.setIssueState(String(project.data.repo), task.data.issue, 'closed')
        },
        'phase.created': async (ctx, event) => {
            const gh = service(ctx)
            const phase = event.payload.record as StoredRecord
            if (!gh || fromGithub(event.actor) || phase.data.milestone || !phase.parentId) return
            const project = await ctx.records.getRaw(phase.parentId)
            if (!project.data.repo) return
            const m = await gh.createMilestone(String(project.data.repo), {
                title: phase.title,
                ...(phase.data.due ? { dueOn: `${phase.data.due}T23:59:59Z` } : {}),
            })
            await ctx.records.update(phase.id, { data: { milestone: m.number } })
        },
        'phase.done': async (ctx, event) => {
            const gh = service(ctx)
            const phase = event.payload.record as StoredRecord
            if (!gh || fromGithub(event.actor) || typeof phase.data.milestone !== 'number' || !phase.parentId) return
            const project = await ctx.records.getRaw(phase.parentId)
            if (project.data.repo) await gh.setMilestoneState(String(project.data.repo), phase.data.milestone, 'closed')
        },
    },
    actions: [
        {
            name: 'github.import_repo',
            label: 'Import a GitHub repo',
            description: "Brings a linked repo's milestones in as phases and its issues in as tasks.",
            managersOnly: true,
            needsApproval: false,
            params: { projectId: { type: 'string', description: 'Project record id with a repo set', required: true } },
            async run(ctx, p) {
                const gh = service(ctx)
                if (!gh) throw new Error('GitHub is not connected. Set GITHUB_TOKEN on the server.')
                const project = await ctx.records.getRaw(String(p.projectId))
                const repo = String(project.data.repo ?? '')
                if (!repo) throw new Error('Set the GitHub repo on this project first')
                const milestones = await gh.listMilestones(repo)
                for (const m of milestones) await upsertPhaseFromMilestone(ctx, project, m)
                const issues = (await gh.listIssues(repo)).filter((i) => !i.isPullRequest)
                for (const i of issues) await upsertTaskFromIssue(ctx, project, i)
                return { phases: milestones.length, tasks: issues.length }
            },
        },
    ],
    tiles: [
        {
            id: 'github.my_reviews',
            title: 'Reviews waiting on you',
            sides: ['employee', 'manage'],
            size: 'sm',
            async load(ctx: Ctx): Promise<TileData> {
                const reviews = await ctx.records.list('review', { status: 'Waiting', where: { user: ctx.actor.id } })
                return {
                    value: String(reviews.length),
                    caption: reviews.length === 1 ? 'pull request to review' : 'pull requests to review',
                    tone: reviews.length ? 'warning' : 'good',
                    items: reviews.map((r) => ({ label: r.title, detail: `${r.data.repo}#${r.data.pr} by ${r.data.author}`, href: String(r.data.url ?? '') })),
                }
            },
        },
        {
            id: 'github.activity',
            title: 'Shipping',
            sides: ['manage'],
            size: 'md',
            async load(ctx: Ctx): Promise<TileData> {
                const rows = await ctx.db.query<{ name: string; payload: Json; created_at: string }>(
                    `select name, payload, created_at from events where company_id = $1
                       and name in ('github.pr_merged', 'github.checks_failed', 'github.release')
                       and created_at > now() - interval '7 days'
                     order by id desc limit 8`,
                    [ctx.companyId],
                )
                const merged = rows.filter((r) => r.name === 'github.pr_merged').length
                const failing = rows.filter((r) => r.name === 'github.checks_failed').length
                return {
                    value: String(merged),
                    caption: `pull requests merged this week${failing ? `, ${failing} failed check runs` : ''}`,
                    tone: failing ? 'warning' : 'neutral',
                    items: rows.map((r) => ({
                        label: r.name === 'github.pr_merged' ? `Merged: ${r.payload.title}` : r.name === 'github.release' ? `Released ${r.payload.name}` : `Checks failed: ${r.payload.name}`,
                        detail: `${r.payload.repo}${r.payload.branch ? ` · ${r.payload.branch}` : ''}`,
                        href: r.payload.url ?? undefined,
                        tone: (r.name === 'github.checks_failed' ? 'critical' : 'neutral') as TileData['tone'],
                    })),
                }
            },
        },
    ],
})
