import type { Ctx } from '@studio-os/core'
import type { GithubIssue, GithubMilestone, GithubService } from '@studio-os/module-github'
import type { MailService } from '@studio-os/module-money'

/** GitHub over its REST API with a token (a fine-grained PAT or an app installation token). */
export function githubService(token: string, fetchImpl: typeof fetch = fetch): GithubService
{
    async function gh<T>(method: string, path: string, body?: unknown): Promise<T>
    {
        const res = await fetchImpl(`https://api.github.com${path}`, {
            method,
            headers: {
                authorization: `Bearer ${token}`,
                accept: 'application/vnd.github+json',
                'x-github-api-version': '2022-11-28',
                'user-agent': 'studio-os',
                ...(body ? { 'content-type': 'application/json' } : {}),
            },
            ...(body ? { body: JSON.stringify(body) } : {}),
        })
        if (!res.ok) throw new Error(`GitHub ${method} ${path} failed: ${res.status} ${await res.text()}`)
        return (await res.json()) as T
    }
    const repoPath = (repo: string) => {
        if (!/^[\w.-]+\/[\w.-]+$/.test(repo)) throw new Error(`"${repo}" is not an owner/name repo`)
        return `/repos/${repo}`
    }
    return {
        async createIssue(repo, issue) {
            const r = await gh<{ number: number; html_url: string }>('POST', `${repoPath(repo)}/issues`, issue)
            return { number: r.number, url: r.html_url }
        },
        async setIssueState(repo, number, state) {
            await gh('PATCH', `${repoPath(repo)}/issues/${number}`, { state })
        },
        async createMilestone(repo, m) {
            const r = await gh<{ number: number }>('POST', `${repoPath(repo)}/milestones`, { title: m.title, ...(m.dueOn ? { due_on: m.dueOn } : {}) })
            return { number: r.number }
        },
        async setMilestoneState(repo, number, state) {
            await gh('PATCH', `${repoPath(repo)}/milestones/${number}`, { state })
        },
        async listIssues(repo) {
            const rows = await gh<any[]>('GET', `${repoPath(repo)}/issues?state=all&per_page=100`)
            return rows.map((i): GithubIssue => ({
                number: i.number,
                title: i.title,
                state: i.state,
                url: i.html_url,
                milestone: i.milestone?.number ?? null,
                assignee: i.assignee?.login ?? null,
                isPullRequest: !!i.pull_request,
            }))
        },
        async listMilestones(repo) {
            const rows = await gh<any[]>('GET', `${repoPath(repo)}/milestones?state=all&per_page=100`)
            return rows.map((m): GithubMilestone => ({ number: m.number, title: m.title, state: m.state, dueOn: m.due_on ?? null }))
        },
    }
}

/**
 * Mail. With a Resend key it sends; without one, messages land in the outbox
 * (an event the Activity page shows). The public demo runs without a key so
 * it never emails a real person.
 */
export function mailService(opts: { resendKey?: string | undefined; from?: string | undefined }): MailService & { bind(ctx: Ctx): MailService }
{
    const send = async (ctx: Ctx | null, msg: { to: string; subject: string; text: string }) => {
        if (opts.resendKey && opts.from) {
            const res = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: { authorization: `Bearer ${opts.resendKey}`, 'content-type': 'application/json' },
                body: JSON.stringify({ from: opts.from, to: [msg.to], subject: msg.subject, text: msg.text }),
            })
            if (!res.ok) throw new Error(`Mail failed: ${res.status} ${await res.text()}`)
            return { id: ((await res.json()) as { id: string }).id }
        }
        await ctx?.events.emit('mail.outbox', { payload: { ...msg } })
        return { id: 'outbox' }
    }
    return {
        send: (msg) => send(null, msg),
        bind: (ctx) => ({ send: (msg) => send(ctx, msg) }),
    }
}
