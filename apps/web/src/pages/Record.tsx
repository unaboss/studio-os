import { useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { ago, announceChange, api, money, useApi, type StoredRecord } from '../api.ts'
import { Icon } from '../icons.tsx'
import { Empty, FieldValue, PageHead, Pill, RecordActions, RecordForm, RecordTable, StatusPill, useStudio } from '../ui.tsx'

interface Detail
{
    record: StoredRecord
    parent: StoredRecord | null
    children: Record<string, StoredRecord[]>
    events: { name: string; actor_id: string; actor_kind: string; payload: any; created_at: string }[]
}

const LIST_COLUMNS: Record<string, string[]> = {
    task: ['assignee', 'due'],
    phase: ['order', 'share', 'due'],
    invoice: ['number', 'amount', 'due'],
    time: ['user', 'date', 'hours'],
    payment: ['amount', 'date'],
    review: ['user', 'pr'],
    quote: ['amount', 'validUntil'],
}

export function RecordPage()
{
    const { id = '' } = useParams()
    const { type, me, toast } = useStudio()
    const { data, error, reload } = useApi<Detail>(`/api/record/${id}`)
    const [editing, setEditing] = useState(false)
    if (error) return <Empty title="Not found">{error}</Empty>
    if (!data || data.record.id !== id) return <div className="empty">Loading…</div>
    const { record, parent, children } = data
    const rt = type(record.type)
    if (!rt) return <Empty title="This kind of record is switched off" />
    const isManager = me.role === 'manager'
    const allowedStatuses = rt.statuses.filter((s) => isManager || !(rt.managerStatuses ?? []).includes(s) || s === record.status)
    const canEdit = isManager || rt.employeeEditable !== false

    const setStatus = async (status: string) => {
        try {
            await api(`/api/record/${record.id}`, { method: 'PATCH', body: { status } })
            toast(`Marked ${status.toLowerCase()}`)
            reload()
            announceChange()
        } catch (e) {
            toast((e as Error).message, true)
        }
    }

    return (
        <>
            <div className="small muted" style={{ marginBottom: 6 }}>
                {parent ? <Link to={`/records/${parent.id}`}>{parent.title}</Link> : rt.plural}
            </div>
            <PageHead title={record.title} sub={<span className="row"><StatusPill status={record.status} /><span>{rt.label}</span>{record.data.url ? <a href={record.data.url} target="_blank" rel="noreferrer" className="row small"><Icon.github /> Open on GitHub</a> : null}</span>}>
                {canEdit ? (
                    <select className="select" style={{ width: 'auto' }} value={record.status} onChange={(e) => setStatus(e.target.value)} aria-label="Status">
                        {allowedStatuses.map((s) => <option key={s}>{s}</option>)}
                    </select>
                ) : null}
                {canEdit ? <button className="btn" onClick={() => setEditing(true)}>Edit</button> : null}
                <RecordActions record={record} exclude={['task.move', 'phase.complete']} />
            </PageHead>

            {record.type === 'project' ? <ProjectView record={record} children={children} /> : null}

            <div className="card card-pad">
                <div className="kv">
                    {rt.fields.filter((f) => f.key !== 'fingerprint').map((f) => (
                        <div key={f.key} style={{ display: 'contents' }}>
                            <div className="k">{f.label}{f.custom ? <span className="faint small"> · custom</span> : null}</div>
                            <div><FieldValue field={f} value={record.data[f.key]} /></div>
                        </div>
                    ))}
                </div>
            </div>

            {Object.entries(children).filter(([t]) => record.type !== 'project' || !['task', 'phase'].includes(t)).map(([t, list]) => {
                const crt = type(t)
                if (!crt || list.length === 0) return null
                return (
                    <section className="section" key={t}>
                        <h2>{crt.plural}</h2>
                        <div className="card"><RecordTable rt={crt} records={list} columns={LIST_COLUMNS[t] ?? []} /></div>
                    </section>
                )
            })}

            {data.events.length ? (
                <section className="section">
                    <h2>History</h2>
                    <div className="card card-pad">
                        <ul className="timeline">
                            {data.events.filter((e) => !e.name.endsWith('.updated') || e.payload?.changes).slice(0, 20).map((e, i) => (
                                <li key={i}><span>{describeEvent(e)}</span><span className="small faint">{e.actor_kind === 'user' ? '' : e.actor_id}</span><time>{ago(e.created_at)}</time></li>
                            ))}
                        </ul>
                    </div>
                </section>
            ) : null}

            {editing ? <RecordForm rt={rt} initial={record} onCancel={() => setEditing(false)} onSaved={() => { setEditing(false); reload() }} /> : null}
        </>
    )
}

function describeEvent(e: Detail['events'][number]): string
{
    const [, what] = e.name.split('.')
    if (what === 'created') return 'Created'
    if (what === 'status_changed') return `${e.payload.from} → ${e.payload.to}`
    if (what === 'updated') return `Changed ${Object.keys(e.payload.changes ?? {}).join(', ') || 'details'}`
    if (e.name === 'invoice.overdue') return `Overdue by ${e.payload.daysOverdue} days`
    if (e.name.startsWith('github.')) return e.name.replace('github.', 'GitHub: ').replace(/_/g, ' ')
    return e.name.replace(/[._]/g, ' ')
}

const LANES = ['To do', 'In progress', 'In review', 'Done']

function ProjectView({ record, children }: { record: StoredRecord; children: Record<string, StoredRecord[]> })
{
    const { me, userName, type } = useStudio()
    const [adding, setAdding] = useState(false)
    const phases = [...(children.phase ?? [])].sort((a, b) => Number(a.data.order) - Number(b.data.order))
    const tasks = children.task ?? []
    const invoices = children.invoice ?? []
    const current = phases.find((p) => p.status !== 'Done')
    const taskType = type('task')
    const lanes = taskType?.statuses ?? LANES

    const move = async (task: StoredRecord, status: string) => {
        await api('/api/actions/task.move', { body: { taskId: task.id, status } })
        announceChange()
    }

    return (
        <>
            {phases.length ? (
                <section style={{ marginBottom: 24 }}>
                    <div className="spread" style={{ marginBottom: 10 }}>
                        <h2>Phases and payments</h2>
                        {record.data.value !== undefined ? <span className="muted num">Project value {money(record.data.value, me.currency)}</span> : null}
                    </div>
                    <div className="phases">
                        {phases.map((p) => {
                            const inv = invoices.find((i) => i.data.phase === p.id)
                            return (
                                <Link key={p.id} to={`/records/${p.id}`} className={`phase ${p.status === 'Done' ? 'done' : ''} ${current?.id === p.id ? 'current' : ''}`} style={{ textDecoration: 'none' }}>
                                    <div className="small faint">Phase {p.data.order}{p.data.milestone ? ` · milestone #${p.data.milestone}` : ''}</div>
                                    <div style={{ fontWeight: 600, margin: '2px 0 8px' }}>{p.title}</div>
                                    {p.data.share !== undefined ? <div className="share">{Math.round(Number(p.data.share) * 100)}%</div> : null}
                                    <div className="row small" style={{ marginTop: 6 }}>
                                        <StatusPill status={p.status} />
                                        {inv ? <Pill tone={inv.status === 'Paid' ? 'good' : 'warning'}>{String(inv.data.number)} {inv.status.toLowerCase()}</Pill> : null}
                                    </div>
                                </Link>
                            )
                        })}
                    </div>
                </section>
            ) : null}

            <section style={{ marginBottom: 24 }}>
                <div className="spread" style={{ marginBottom: 10 }}>
                    <h2>Tasks {record.data.repo ? <span className="small faint mono">· synced with {String(record.data.repo)}</span> : null}</h2>
                    <div style={{ display: 'flex', gap: 8 }}>
                        {record.data.repo ? <Link className="btn sm" to={`/code?repo=${encodeURIComponent(String(record.data.repo))}`}><Icon.tree /> Code tree</Link> : null}
                        <button className="btn sm primary" onClick={() => setAdding(true)}><Icon.plus /> Task</button>
                    </div>
                </div>
                <div className="board">
                    {lanes.map((lane) => {
                        const inLane = tasks.filter((t) => t.status === lane)
                        return (
                            <div className="lane" key={lane}>
                                <h3>{lane}<span className="faint">{inLane.length}</span></h3>
                                {inLane.map((t) => {
                                    const phase = phases.find((p) => p.id === t.data.phase)
                                    const i = lanes.indexOf(lane)
                                    return (
                                        <div className="task" key={t.id}>
                                            <Link to={`/records/${t.id}`}>{t.title}</Link>
                                            <div className="meta">
                                                {t.data.issue ? <span className="mono">#{t.data.issue}</span> : null}
                                                {t.data.assignee ? <span>{userName(t.data.assignee)}</span> : null}
                                                {t.data.due ? <span>due {String(t.data.due).slice(5)}</span> : null}
                                                {phase ? <span>{phase.title}</span> : null}
                                            </div>
                                            <div className="row" style={{ marginTop: 6, gap: 4 }}>
                                                {i > 0 ? <button className="btn ghost sm" aria-label={`Move to ${lanes[i - 1]}`} onClick={() => move(t, lanes[i - 1]!)}>←</button> : null}
                                                {i < lanes.length - 1 ? <button className="btn ghost sm" onClick={() => move(t, lanes[i + 1]!)}>{lanes[i + 1]} →</button> : null}
                                            </div>
                                        </div>
                                    )
                                })}
                            </div>
                        )
                    })}
                </div>
            </section>
            {adding && taskType ? <RecordForm rt={taskType} parentId={record.id} defaults={current ? { phase: current.id } : {}} onCancel={() => setAdding(false)} onSaved={() => setAdding(false)} /> : null}
        </>
    )
}
