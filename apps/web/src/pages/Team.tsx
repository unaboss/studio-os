// People: everyone who grows the trees, solo or as a team. Each card opens a profile.
import { Link } from 'react-router-dom'
import { ago, useApi } from '../api.ts'
import { Avatar, realLogin } from '../avatar.tsx'
import { Empty } from '../ui.tsx'

export interface Person
{
    id: string; name: string; email: string; role: string; github: string | null
    commits14: number; total?: number; calendar?: Record<string, number>; projects?: string[]; lastCommit: string | null
    branches: { repo: string; project: string; name: string; date: string; subject: string; sha: string }[]
    recent: { repo: string; project: string; sha: string; subject: string; date: string }[]
    reviews: { id: string; title: string; repo: string; pr: number; url: string | null; author: string | null }[]
}

/** The last weeks as a row of quiet bars, newest on the right. */
export function Sparkweeks({ calendar, weeks = 12 }: { calendar: Record<string, number>; weeks?: number })
{
    const now = new Date()
    const counts = Array.from({ length: weeks }, (_, w) => {
        let n = 0
        for (let d = 0; d < 7; d++) {
            const day = new Date(now.getTime() - ((weeks - 1 - w) * 7 + d) * 86_400_000).toISOString().slice(0, 10)
            n += calendar[day] ?? 0
        }
        return n
    })
    const max = Math.max(1, ...counts)
    return (
        <div className="sparkweeks" aria-label={`Commits per week, last ${weeks} weeks`}>
            {counts.map((n, i) => <i key={i} style={{ height: `${Math.max(8, (n / max) * 100)}%` }} className={n ? 'on' : ''} title={`${n} commits`} />)}
        </div>
    )
}

export function Team()
{
    const { data, error } = useApi<{ people: Person[] }>('/api/code/people')
    const people = data?.people ?? []
    const solo = people.length === 1
    return (
        <div className="people-page">
            <header className="people-head">
                <h1>{solo ? 'You' : 'People'}</h1>
                <p>{solo ? 'Your work across every project, read from the code.' : `${people.length} people building across your projects, read from the code.`}</p>
            </header>
            {error ? <Empty title="Could not load people">{error}</Empty> : null}
            {data && !people.length ? <Empty title="No one here yet">Add your team in Settings.</Empty> : null}
            <div className="people-grid">
                {people.map((p) => (
                    <Link key={p.id} to={`/team/${p.id}`} className="person-card">
                        <Avatar name={p.name} email={p.email} github={p.github} size={64} ring />
                        <div className="person-id">
                            <b>{p.name}</b>
                            <span className="small faint">{realLogin(p.github, p.email) ? `@${p.github}` : p.role === 'manager' ? 'Manager' : 'Developer'}</span>
                        </div>
                        {p.calendar ? <Sparkweeks calendar={p.calendar} /> : null}
                        <div className="person-nums">
                            <span><b className="num">{p.total ?? p.recent.length}</b> commits</span>
                            <span><b className="num">{p.branches.length}</b> open</span>
                            <span className="faint">{p.lastCommit ? `active ${ago(p.lastCommit)}` : 'no commits yet'}</span>
                        </div>
                        {p.reviews.length ? <span className="person-badge">{p.reviews.length} {p.reviews.length === 1 ? 'review' : 'reviews'} waiting</span> : null}
                    </Link>
                ))}
            </div>
        </div>
    )
}
