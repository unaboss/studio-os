import { useState } from 'react'
import { Link } from 'react-router-dom'
import { announceChange, api, date, money, today, useApi, type StoredRecord } from '../api.ts'
import { Icon } from '../icons.tsx'
import { Empty, Pill, RecordForm, StatusPill, Tiles, useRunAction, useStudio } from '../ui.tsx'

function greeting(): string
{
    const h = (new Date().getUTCHours() + 2) % 24
    return h < 12 ? 'Morning' : h < 17 ? 'Afternoon' : 'Evening'
}

export function MyDay()
{
    const { me, type } = useStudio()
    const [form, setForm] = useState<'time' | 'expense' | 'leave' | null>(null)
    return (
        <>
            <h1 style={{ marginBottom: 4 }}>{greeting()}, {me.name.split(' ')[0]}</h1>
            <p className="muted" style={{ marginBottom: 16 }}>{new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' })}</p>
            <div className="row" style={{ marginBottom: 18 }}>
                {type('time') ? <button className="btn" onClick={() => setForm('time')}><Icon.time /> Log time</button> : null}
                {type('expense') ? <button className="btn" onClick={() => setForm('expense')}><Icon.receipt /> Claim</button> : null}
                {type('leave') ? <button className="btn" onClick={() => setForm('leave')}><Icon.leave /> Leave</button> : null}
            </div>
            <Tiles side="employee" />
            {form === 'time' ? <LogTime onClose={() => setForm(null)} /> : null}
            {form === 'expense' && type('expense') ? <RecordForm rt={type('expense')!} hidden={['claimant']} defaults={{ date: today() }} onCancel={() => setForm(null)} onSaved={() => setForm(null)} /> : null}
            {form === 'leave' && type('leave') ? <RecordForm rt={type('leave')!} hidden={['user', 'days']} defaults={{ kind: 'Annual' }} onCancel={() => setForm(null)} onSaved={() => setForm(null)} /> : null}
        </>
    )
}

export function MyTasks()
{
    const run = useRunAction()
    const { data } = useApi<{ records: StoredRecord[] }>('/api/records/task?w.assignee=me&status=To do,In progress,In review')
    const tasks = data?.records ?? []
    const next: Record<string, string> = { 'To do': 'In progress', 'In progress': 'In review', 'In review': 'Done' }
    return (
        <>
            <h1 style={{ marginBottom: 14 }}>My tasks</h1>
            <div className="card">
                {data && tasks.length === 0 ? <Empty title="Nothing assigned to you">Tasks assigned on GitHub show up here too.</Empty> : null}
                <ul className="list">
                    {tasks.sort((a, b) => String(a.data.due ?? '9').localeCompare(String(b.data.due ?? '9'))).map((t) => (
                        <li key={t.id}>
                            <div className="grow">
                                <Link to={`/records/${t.id}`}><strong style={{ fontWeight: 550 }}>{t.title}</strong></Link>
                                <div className="small muted row" style={{ gap: 6 }}>
                                    <StatusPill status={t.status} />
                                    {t.data.issue ? <span className="mono">#{t.data.issue}</span> : null}
                                    {t.data.due ? <span style={String(t.data.due) < today() ? { color: 'var(--critical)' } : {}}>due {date(t.data.due)}</span> : null}
                                </div>
                            </div>
                            {next[t.status] ? <button className="btn sm" onClick={() => run('task.move', { taskId: t.id, status: next[t.status]! })}>{next[t.status]}</button> : null}
                        </li>
                    ))}
                </ul>
            </div>
        </>
    )
}

function LogTime({ onClose }: { onClose: () => void })
{
    const { toast } = useStudio()
    const projects = useApi<{ records: StoredRecord[] }>('/api/records/project?status=Active')
    const [form, setForm] = useState({ project: '', date: today(), hours: '', note: '' })
    const [error, setError] = useState<string | null>(null)
    const save = async () => {
        try {
            const project = projects.data?.records.find((p) => p.id === form.project)
            await api('/api/records/time', {
                body: {
                    title: `${project?.title ?? 'Time'} · ${form.date}`,
                    status: 'Logged',
                    ...(form.project ? { parentId: form.project } : {}),
                    data: { user: 'me', date: form.date, hours: Number(form.hours), ...(form.project ? { project: form.project } : {}), note: form.note, source: 'Manual', billable: true },
                },
            })
            toast('Time logged')
            announceChange()
            onClose()
        } catch (e) {
            setError((e as Error).message)
        }
    }
    return (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className="dialog" role="dialog" aria-label="Log time">
                <div className="dialog-head"><h2>Log time</h2><button className="btn ghost sm" onClick={onClose} aria-label="Close"><Icon.x /></button></div>
                <div className="dialog-body">
                    {error ? <div className="error-box">{error}</div> : null}
                    <label className="field"><span>Project</span>
                        <select className="select" value={form.project} onChange={(e) => setForm({ ...form, project: e.target.value })}>
                            <option value="">Not on a project</option>
                            {projects.data?.records.map((p) => <option key={p.id} value={p.id}>{p.title}</option>)}
                        </select>
                    </label>
                    <div className="form-grid">
                        <label className="field"><span>Date</span><input className="input" type="date" value={form.date} onChange={(e) => setForm({ ...form, date: e.target.value })} /></label>
                        <label className="field"><span>Hours</span><input className="input num" type="number" step="0.25" inputMode="decimal" value={form.hours} onChange={(e) => setForm({ ...form, hours: e.target.value })} /></label>
                    </div>
                    <label className="field"><span>What you did</span><textarea className="textarea" value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} /></label>
                </div>
                <div className="dialog-foot"><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Log</button></div>
            </div>
        </div>
    )
}

export function MyTime()
{
    const run = useRunAction()
    const suggested = useApi<{ records: StoredRecord[] }>('/api/records/time?w.user=me&status=Suggested')
    const logged = useApi<{ records: StoredRecord[] }>('/api/records/time?w.user=me&status=Logged,Approved&limit=40')
    const [logging, setLogging] = useState(false)
    const [hours, setHours] = useState<Record<string, string>>({})
    return (
        <>
            <div className="spread" style={{ marginBottom: 14 }}>
                <h1>Time</h1>
                <button className="btn primary sm" onClick={() => setLogging(true)}><Icon.plus /> Log time</button>
            </div>
            {suggested.data?.records.length ? (
                <div className="card" style={{ marginBottom: 16 }}>
                    <div className="card-head"><h2><Icon.github /> Suggested from your commits</h2></div>
                    <ul className="list">
                        {suggested.data.records.map((t) => (
                            <li key={t.id} style={{ alignItems: 'flex-start' }}>
                                <div className="grow">
                                    <strong style={{ fontWeight: 550 }}>{t.title}</strong>
                                    <pre className="small muted" style={{ whiteSpace: 'pre-wrap', font: 'inherit', margin: '4px 0 0' }}>{t.data.note}</pre>
                                </div>
                                <input className="input num" style={{ width: 70 }} type="number" step="0.25" aria-label="Hours" value={hours[t.id] ?? String(t.data.hours)} onChange={(e) => setHours({ ...hours, [t.id]: e.target.value })} />
                                <button className="btn sm primary" onClick={() => run('time.confirm', { timeId: t.id, hours: Number(hours[t.id] ?? t.data.hours) })}>Confirm</button>
                            </li>
                        ))}
                    </ul>
                </div>
            ) : null}
            <div className="card">
                <div className="card-head"><h2>Logged</h2></div>
                {logged.data?.records.length === 0 ? <Empty title="No time logged yet" /> : null}
                <ul className="list">
                    {logged.data?.records.map((t) => (
                        <li key={t.id}>
                            <div className="grow"><strong style={{ fontWeight: 550 }}>{t.title.split(' · ')[0]}</strong><div className="small muted">{date(t.data.date)}{t.data.note ? ` · ${String(t.data.note).split('\n')[0]}` : ''}</div></div>
                            <span className="num">{t.data.hours} h</span>
                        </li>
                    ))}
                </ul>
            </div>
            {logging ? <LogTime onClose={() => setLogging(false)} /> : null}
        </>
    )
}

export function MyClaims()
{
    const { type, me } = useStudio()
    const { data } = useApi<{ records: StoredRecord[] }>('/api/records/expense?w.claimant=me&limit=50')
    const [adding, setAdding] = useState(false)
    const rt = type('expense')
    if (!rt) return <Empty title="Expense claims are switched off" />
    return (
        <>
            <div className="spread" style={{ marginBottom: 14 }}>
                <h1>Expense claims</h1>
                <button className="btn primary sm" onClick={() => setAdding(true)}><Icon.plus /> Claim</button>
            </div>
            <div className="card">
                {data?.records.length === 0 ? <Empty title="No claims yet">Paid for something for work? Claim it here with a photo of the slip.</Empty> : null}
                <ul className="list">
                    {data?.records.map((c) => (
                        <li key={c.id}>
                            <div className="grow"><strong style={{ fontWeight: 550 }}>{c.title}</strong><div className="small muted">{date(c.data.date)}{c.data.category ? ` · ${c.data.category}` : ''}</div></div>
                            <span className="num">{money(c.data.amount, me.currency)}</span>
                            <StatusPill status={c.status} />
                        </li>
                    ))}
                </ul>
            </div>
            {adding ? <RecordForm rt={rt} hidden={['claimant']} defaults={{ date: today() }} onCancel={() => setAdding(false)} onSaved={() => setAdding(false)} /> : null}
        </>
    )
}

export function MyLeave()
{
    const { type, me } = useStudio()
    const leave = useApi<{ records: StoredRecord[] }>('/api/records/leave?w.user=me&limit=50')
    const slips = useApi<{ records: StoredRecord[] }>('/api/records/payslip?w.user=me&status=Issued&limit=24')
    const [adding, setAdding] = useState(false)
    const rt = type('leave')
    if (!rt) return <Empty title="Leave is switched off" />
    return (
        <>
            <div className="spread" style={{ marginBottom: 14 }}>
                <h1>Leave and pay</h1>
                <button className="btn primary sm" onClick={() => setAdding(true)}><Icon.plus /> Request leave</button>
            </div>
            <div className="card" style={{ marginBottom: 16 }}>
                <div className="card-head"><h2>Leave</h2></div>
                {leave.data?.records.length === 0 ? <Empty title="No leave booked" /> : null}
                <ul className="list">
                    {leave.data?.records.map((l) => (
                        <li key={l.id}>
                            <div className="grow"><strong style={{ fontWeight: 550 }}>{l.data.kind}</strong> <span className="muted">· {l.title}</span><div className="small muted">{date(l.data.from)} to {date(l.data.to)} · {l.data.days ?? '?'} days</div></div>
                            <StatusPill status={l.status} />
                        </li>
                    ))}
                </ul>
            </div>
            <div className="card">
                <div className="card-head"><h2>Payslips</h2></div>
                {slips.data?.records.length === 0 ? <Empty title="No payslips yet" /> : null}
                <ul className="list">
                    {slips.data?.records.map((p) => (
                        <li key={p.id}>
                            <div className="grow"><strong style={{ fontWeight: 550 }}>{p.data.month}</strong><div className="small muted">Gross {money(p.data.gross, me.currency)} · PAYE {money(p.data.paye, me.currency)} · UIF {money(p.data.uif, me.currency)}</div></div>
                            <Pill tone="good">{money(p.data.net, me.currency)}</Pill>
                        </li>
                    ))}
                </ul>
            </div>
            {adding ? <RecordForm rt={rt} hidden={['user', 'days']} defaults={{ kind: 'Annual' }} onCancel={() => setAdding(false)} onSaved={() => setAdding(false)} /> : null}
        </>
    )
}
