// People: each developer's work across every project, from the code itself.
import { Link } from 'react-router-dom'
import { ago, useApi } from '../api.ts'
import { Icon } from '../icons.tsx'
import { Empty, PageHead } from '../ui.tsx'
import { colour, initials } from './CodeTree.tsx'

interface Person
{
    id: string; name: string; email: string; role: string; github: string | null
    commits14: number; lastCommit: string | null
    branches: { repo: string; project: string; name: string; date: string; subject: string; sha: string }[]
    recent: { repo: string; project: string; sha: string; subject: string; date: string }[]
    reviews: { id: string; title: string; repo: string; pr: number; url: string | null; author: string | null }[]
}

const tree = (repo: string, sha: string) => `/code?repo=${encodeURIComponent(repo)}&sha=${sha}`

export function Team()
{
    const { data, error } = useApi<{ people: Person[] }>('/api/code/people')
    const people = data?.people ?? []
    return (
        <>
            <PageHead title="People" sub="What everyone is building right now, read from the code: open branches, recent commits and the reviews waiting on them." />
            {error ? <Empty title="Could not load people">{error}</Empty> : null}
            {data && !people.length ? <Empty title="No one here yet">Add your team in Settings.</Empty> : null}
            <div className="people-grid">
                {people.map((p) => (
                    <section key={p.id} className="card person">
                        <header>
                            <span className="avatar lg" style={{ background: colour(p.email) }}>{initials(p.name)}</span>
                            <div className="grow">
                                <h2>{p.name}</h2>
                                <div className="small faint">
                                    {p.role === 'manager' ? 'Manager' : 'Developer'}
                                    {p.github ? <> · <a href={`https://github.com/${p.github}`} target="_blank" rel="noreferrer">@{p.github}</a></> : null}
                                </div>
                            </div>
                            <div className="person-stats">
                                <div><b className="num">{p.commits14}</b><span className="small faint">commits, 14 days</span></div>
                                <div><b className="num">{p.branches.length}</b><span className="small faint">open {p.branches.length === 1 ? 'branch' : 'branches'}</span></div>
                            </div>
                        </header>

                        {p.reviews.length ? (
                            <div className="person-block">
                                <h3>Reviews waiting on {p.name.split(' ')[0]}</h3>
                                <ul className="plain">
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

                        <div className="person-block">
                            <h3>Working on</h3>
                            {p.branches.length ? (
                                <ul className="plain">
                                    {p.branches.map((b) => (
                                        <li key={b.repo + b.name}>
                                            <Icon.tree />
                                            <Link to={tree(b.repo, b.sha)} className="mono">{b.name}</Link>
                                            <span className="small faint">{b.project} · {ago(b.date)}</span>
                                        </li>
                                    ))}
                                </ul>
                            ) : <div className="small faint">No open branches.</div>}
                        </div>

                        <div className="person-block">
                            <h3>Recent commits</h3>
                            {p.recent.length ? (
                                <ul className="plain">
                                    {p.recent.map((c) => (
                                        <li key={c.repo + c.sha}>
                                            <Link to={tree(c.repo, c.sha)} className="mono small">{c.sha.slice(0, 7)}</Link>
                                            <span className="grow ellipsis">{c.subject}</span>
                                            <span className="small faint">{c.project} · {ago(c.date)}</span>
                                        </li>
                                    ))}
                                </ul>
                            ) : <div className="small faint">No commits yet{p.github ? '' : '. Link their GitHub login in Settings so commits match'}.</div>}
                        </div>
                    </section>
                ))}
            </div>
        </>
    )
}
