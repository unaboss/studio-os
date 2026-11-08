// What the code says about each project and each person: a health dot per
// project, and per person their open branches, recent commits and reviews.
import type { Ctx, Db, StoredRecord } from '@studio-os/core'
import type { CodeRepos, TreeGraph } from './codetree.ts'

export interface ProjectRepo { projectId: string; project: string; status: string; repo: string; clientId: string; client: string }
export type Health = 'attention' | 'watch' | 'good'

const STALE_DAYS = 10
const QUIET_DAYS = 14
const days = (iso: string, now: Date) => Math.floor((now.getTime() - new Date(iso).getTime()) / 86_400_000)

async function graphs(code: CodeRepos | null, repos: ProjectRepo[]): Promise<Map<string, TreeGraph>>
{
    const out = new Map<string, TreeGraph>()
    if (!code) return out
    await Promise.all(repos.map(async (r) => {
        try {
            out.set(r.projectId, await code.graph(r.repo))
        } catch {
            // An unreadable repo just has no signals.
        }
    }))
    return out
}

/** Failed checks with no pass since, by project id. */
async function failingChecks(ctx: Ctx, db: Db): Promise<Map<string, string>>
{
    const rows = await db.query<{ name: string; record_id: string; payload: Record<string, unknown> }>(
        `select name, record_id, payload from events where company_id = $1 and name in ('github.checks_failed', 'github.checks_passed') order by id`,
        [ctx.companyId],
    )
    const failing = new Map<string, string>()
    for (const r of rows) {
        if (r.name === 'github.checks_failed') failing.set(r.record_id, String(r.payload.branch ?? ''))
        else failing.delete(r.record_id)
    }
    return failing
}

async function waitingReviews(ctx: Ctx): Promise<StoredRecord[]>
{
    if (!ctx.registry.recordTypes().some((rt) => rt.type === 'review')) return []
    return ctx.records.list('review', { status: 'Waiting', limit: 500 })
}

/** Each branch's tip: who last touched it and when. */
function branchTips(g: TreeGraph)
{
    const bySha = new Map(g.commits.map((c) => [c.sha, c]))
    return g.branches.filter((b) => b.name !== g.defaultBranch).flatMap((b) => {
        const tip = bySha.get(b.sha)
        return tip ? [{ name: b.name, sha: b.sha, author: tip.author, email: tip.email, date: tip.date, subject: tip.subject }] : []
    })
}

export async function projectHealth(ctx: Ctx, db: Db, code: CodeRepos | null, repos: ProjectRepo[], now: Date)
{
    const [g, failing, reviews] = await Promise.all([graphs(code, repos), failingChecks(ctx, db), waitingReviews(ctx)])
    const out = new Map<string, { health: Health; reasons: string[]; openBranches: number; lastCommit: string | null }>()
    for (const r of repos) {
        const graph = g.get(r.projectId)
        const reasons: string[] = []
        let health: Health = 'good'
        const fail = failing.get(r.projectId)
        if (fail !== undefined) {
            reasons.push(`Checks are failing${fail ? ` on ${fail}` : ''}`)
            health = 'attention'
        }
        const tips = graph ? branchTips(graph) : []
        for (const t of tips.filter((t) => days(t.date, now) > STALE_DAYS)) {
            reasons.push(`${t.name} has had no commits for ${days(t.date, now)} days`)
            if (health === 'good') health = 'watch'
        }
        const waiting = reviews.filter((v) => v.parentId === r.projectId || v.data.project === r.projectId || v.data.repo === r.repo)
        if (waiting.length) {
            reasons.push(`${waiting.length} ${waiting.length === 1 ? 'review is' : 'reviews are'} waiting`)
            if (health === 'good') health = 'watch'
        }
        const last = graph?.commits[0]?.date ?? null
        if (r.status === 'Active' && last && days(last, now) > QUIET_DAYS) {
            reasons.push(`No commits for ${days(last, now)} days`)
            if (health === 'good') health = 'watch'
        }
        out.set(r.projectId, { health, reasons, openBranches: tips.length, lastCommit: last })
    }
    return out
}

export async function codePeople(ctx: Ctx, db: Db, code: CodeRepos | null, repos: ProjectRepo[], now: Date)
{
    const [g, reviews, users] = await Promise.all([
        graphs(code, repos),
        waitingReviews(ctx),
        db.query<{ id: string; name: string; email: string; role: string; github_login: string | null; active: boolean }>(
            'select id, name, email, role, github_login, active from users where company_id = $1 order by name',
            [ctx.companyId],
        ),
    ])
    const since = new Date(now.getTime() - 14 * 86_400_000).toISOString()
    const people = users.filter((u) => u.active).map((u) => {
        const email = u.email.toLowerCase()
        const mine = (c: { email: string; author: string }) => c.email.toLowerCase() === email || c.author === u.name
        const branches: { repo: string; project: string; name: string; date: string; subject: string; sha: string }[] = []
        const recent: { repo: string; project: string; sha: string; subject: string; date: string }[] = []
        let commits14 = 0
        for (const r of repos) {
            const graph = g.get(r.projectId)
            if (!graph) continue
            for (const t of branchTips(graph).filter(mine)) branches.push({ repo: r.repo, project: r.project, name: t.name, date: t.date, subject: t.subject, sha: t.sha })
            for (const c of graph.commits.filter(mine)) {
                if (c.date >= since) commits14++
                recent.push({ repo: r.repo, project: r.project, sha: c.sha, subject: c.subject, date: c.date })
            }
        }
        recent.sort((a, b) => b.date.localeCompare(a.date))
        branches.sort((a, b) => b.date.localeCompare(a.date))
        const toReview = reviews.filter((v) => v.data.user === u.id).map((v) => ({ id: v.id, title: v.title, repo: String(v.data.repo ?? ''), pr: Number(v.data.pr ?? 0), url: (v.data.url as string) ?? null, author: (v.data.author as string) ?? null }))
        return { id: u.id, name: u.name, email: u.email, role: u.role, github: u.github_login, commits14, branches, recent: recent.slice(0, 6), reviews: toReview, lastCommit: recent[0]?.date ?? null }
    })
    return { people }
}
