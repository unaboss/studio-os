import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ago, useApi } from '../api.ts'
import { Empty, PageHead, Pill, useStudio } from '../ui.tsx'

interface Ev { id: number; name: string; record_id: string | null; actor_id: string; actor_kind: string; actor_name: string | null; payload: any; created_at: string }

export function Activity()
{
    const [filter, setFilter] = useState<string>('')
    const { data } = useApi<{ events: Ev[] }>(`/api/activity?limit=150${filter ? `&name=${filter}` : ''}`)
    const { userName } = useStudio()
    return (
        <>
            <PageHead title="Activity" sub="Everything that happened, who or what did it, and every email the system wrote.">
                <select className="select" style={{ width: 'auto' }} value={filter} onChange={(e) => setFilter(e.target.value)}>
                    <option value="">Everything</option>
                    <option value="mail.outbox">Outbox (emails)</option>
                    <option value="agent.brief">Agent briefs</option>
                    <option value="approval.approved">Approvals</option>
                    <option value="github.pr_merged">GitHub merges</option>
                </select>
            </PageHead>
            <div className="card">
                {data?.events.length === 0 ? <Empty title="Nothing yet" /> : null}
                <ul className="list">
                    {data?.events.map((e) => (
                        <li key={e.id} style={{ alignItems: 'flex-start' }}>
                            <div className="grow">
                                <div className="row">
                                    <span className="mono">{e.name}</span>
                                    {e.actor_kind !== 'user' ? <Pill tone="accent">{userName(e.actor_id)}</Pill> : <span className="small muted">{e.actor_name}</span>}
                                </div>
                                {e.name === 'mail.outbox' ? (
                                    <div className="small" style={{ marginTop: 6 }}>
                                        <div><strong>To</strong> {e.payload.to} · <strong>{e.payload.subject}</strong></div>
                                        <pre style={{ whiteSpace: 'pre-wrap', font: 'inherit', margin: '6px 0 0', color: 'var(--ink-2)' }}>{e.payload.text}</pre>
                                    </div>
                                ) : null}
                                {e.name === 'agent.brief' ? <p className="small muted" style={{ marginTop: 4 }}>{e.payload.text}</p> : null}
                                {e.payload?.record?.title ? <div className="small muted"><Link to={`/records/${e.record_id}`}>{e.payload.record.title}</Link>{e.payload.to ? ` → ${e.payload.to}` : ''}</div> : null}
                                {e.payload?.summary ? <div className="small muted">{e.payload.summary}</div> : null}
                            </div>
                            <time className="small faint">{ago(e.created_at)}</time>
                        </li>
                    ))}
                </ul>
            </div>
        </>
    )
}
