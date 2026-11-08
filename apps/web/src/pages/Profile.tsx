// One person's profile: who they are and what they've grown, from the code itself.
import { useMemo } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ago, useApi } from '../api.ts'
import { Avatar } from '../avatar.tsx'
import { Icon } from '../icons.tsx'
import { Empty } from '../ui.tsx'
import type { Person } from './Team.tsx'

const tree = (repo: string, sha: string) => `/code?repo=${encodeURIComponent(repo)}&sha=${sha}`

/** Half a year of commits, a square a day, like a GitHub profile. */
function Calendar({ calendar }: { calendar: Record<string, number> })
{
    const { weeks, months, total } = useMemo(() => {
        const today = new Date()
        today.setUTCHours(0, 0, 0, 0)
        const start = new Date(today.getTime() - 181 * 86_400_000)
        start.setUTCDate(start.getUTCDate() - start.getUTCDay())
        const weeks: { day: string; n: number; future: boolean }[][] = []
        const months: { col: number; label: string }[] = []
        let total = 0
        for (let d = new Date(start), col = 0; d <= today; col++) {
            const week: { day: string; n: number; future: boolean }[] = []
            for (let i = 0; i < 7; i++) {
                const day = d.toISOString().slice(0, 10)
                const n = calendar[day] ?? 0
                total += n
                week.push({ day, n, future: d > today })
                if (d.getUTCDate() === 1 || (col === 0 && i === 0)) months.push({ col, label: d.toLocaleDateString('en-ZA', { month: 'short', timeZone: 'UTC' }) })
                d = new Date(d.getTime() + 86_400_000)
            }
            weeks.push(week)
        }
        return { weeks, months, total }
    }, [calendar])
    const max = Math.max(1, ...Object.values(calendar))
    const level = (n: number) => (n === 0 ? 0 : Math.min(4, Math.ceil((n / max) * 4)))
    return (
        <div className="calendar">
            <div className="calendar-head"><b>{total}</b> commits in the last six months</div>
            <div className="calendar-grid" style={{ gridTemplateColumns: `repeat(${weeks.length}, 13px)` }}>
                {months.map((m) => <span key={`${m.col}${m.label}`} className="calendar-month" style={{ gridColumn: m.col + 1 }}>{m.label}</span>)}
                {weeks.map((w, c) => w.map((d, r) => (
                    <i key={d.day} style={{ gridColumn: c + 1, gridRow: r + 2 }} className={d.future ? 'future' : `l${level(d.n)}`} title={`${d.n} ${d.n === 1 ? 'commit' : 'commits'} on ${d.day}`} />
                )))}
            </div>
            <div className="calendar-key small faint">Less <i className="l0" /><i className="l1" /><i className="l2" /><i className="l3" /><i className="l4" /> More</div>
        </div>
    )
}

export function Profile()
{
    const { id } = useParams()
    const { data, error } = useApi<{ people: Person[] }>('/api/code/people')
    const p = data?.people.find((x) => x.id === id)
    if (error) return <Empty title="Could not load this profile">{error}</Empty>
    if (!data) return null
    if (!p) return <Empty title="No one by that link">They may have left the team. <Link to="/team">See everyone</Link></Empty>
    return (
        <div className="profile">
            <Link to="/team" className="back-link small"><Icon.back /> People</Link>
            <div className="profile-grid">
                <aside className="profile-side">
                    <Avatar name={p.name} email={p.email} github={p.github} size={200} ring />
                    <h1>{p.name}</h1>
                    <div className="profile-handle">{p.github ? `@${p.github}` : p.email}</div>
                    <div className="profile-role">{p.role === 'manager' ? 'Manager' : 'Developer'}</div>
                    {p.github ? <a className="btn sm block-ish" href={`https://github.com/${p.github}`} target="_blank" rel="noreferrer"><Icon.github /> GitHub profile</a> : null}
                    <dl className="profile-facts">
                        <div><dt>Commits</dt><dd className="num">{p.total ?? p.recent.length}</dd></div>
                        <div><dt>Last 14 days</dt><dd className="num">{p.commits14}</dd></div>
                        <div><dt>Open branches</dt><dd className="num">{p.branches.length}</dd></div>
                        <div><dt>Last active</dt><dd>{p.lastCommit ? ago(p.lastCommit) : '—'}</dd></div>
                    </dl>
                    {p.projects?.length ? (
                        <div className="profile-projects">
                            <h3>Projects</h3>
                            <div className="chips">{p.projects.map((name) => <span key={name} className="pill">{name}</span>)}</div>
                        </div>
                    ) : null}
                </aside>

                <section className="profile-main">
                    {p.calendar ? <Calendar calendar={p.calendar} /> : null}

                    {p.reviews.length ? (
                        <div className="profile-block">
                            <h2>Reviews waiting</h2>
                            <ul className="profile-list">
                                {p.reviews.map((r) => (
                                    <li key={r.id}>
                                        <span className="health watch" />
                                        {r.url ? <a href={r.url} target="_blank" rel="noreferrer">{r.title}</a> : <Link to={`/records/${r.id}`}>{r.title}</Link>}
                                        <span className="small faint mono">{r.repo}{r.pr ? ` #${r.pr}` : ''}</span>
                                    </li>
                                ))}
                            </ul>
                        </div>
                    ) : null}

                    <div className="profile-block">
                        <h2>Working on</h2>
                        {p.branches.length ? (
                            <ul className="profile-list">
                                {p.branches.map((b) => (
                                    <li key={b.repo + b.name}>
                                        <Icon.tree />
                                        <Link to={tree(b.repo, b.sha)} className="mono">{b.name}</Link>
                                        <span className="grow ellipsis faint">{b.subject}</span>
                                        <span className="small faint">{b.project} · {ago(b.date)}</span>
                                    </li>
                                ))}
                            </ul>
                        ) : <div className="small faint">No open branches.</div>}
                    </div>

                    <div className="profile-block">
                        <h2>Recent commits</h2>
                        {p.recent.length ? (
                            <ol className="timeline">
                                {p.recent.map((c) => (
                                    <li key={c.repo + c.sha}>
                                        <Link to={tree(c.repo, c.sha)} className="mono small">{c.sha.slice(0, 7)}</Link>
                                        <span className="grow ellipsis">{c.subject}</span>
                                        <span className="small faint">{c.project} · {ago(c.date)}</span>
                                    </li>
                                ))}
                            </ol>
                        ) : <div className="small faint">No commits yet{p.github ? '' : '. Link a GitHub login in Settings so commits match'}.</div>}
                    </div>
                </section>
            </div>
        </div>
    )
}
