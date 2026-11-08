import { useState } from 'react'
import { announceChange, api, date, money, useApi, type StoredRecord, type User } from '../api.ts'
import { Icon } from '../icons.tsx'
import { Dialog, Empty, PageHead, Pill, RecordList, StatusPill, useRunAction, useStudio } from '../ui.tsx'

type Tab = 'staff' | 'leave' | 'time' | 'payroll' | 'logins'

export function People()
{
    const [tab, setTab] = useState<Tab>('leave')
    return (
        <>
            <PageHead title="People" sub="Staff, leave, time and payroll. Employees see only their own." />
            <div className="tabs">
                {([['leave', 'Leave'], ['time', 'Time'], ['payroll', 'Payroll'], ['staff', 'Staff'], ['logins', 'Logins']] as [Tab, string][]).map(([t, label]) => (
                    <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{label}</button>
                ))}
            </div>
            {tab === 'staff' ? <RecordList type="person" columns={['user', 'jobTitle', 'salary', 'github']} /> : null}
            {tab === 'leave' ? <LeaveRequests /> : null}
            {tab === 'time' ? <RecordList type="time" columns={['user', 'date', 'hours', 'project', 'source']} /> : null}
            {tab === 'payroll' ? <Payroll /> : null}
            {tab === 'logins' ? <Logins /> : null}
        </>
    )
}

function LeaveRequests()
{
    const { userName } = useStudio()
    const run = useRunAction()
    const { data } = useApi<{ records: StoredRecord[] }>('/api/records/leave?status=Requested')
    return (
        <div className="stack">
            <div className="card">
                <div className="card-head"><h2>Waiting for a decision</h2></div>
                {data?.records.length === 0 ? <Empty title="No leave requests waiting" /> : null}
                <ul className="list">
                    {data?.records.map((l) => (
                        <li key={l.id}>
                            <div className="grow">
                                <strong>{userName(l.data.user)}</strong> · {l.data.kind}
                                <div className="small muted">{date(l.data.from)} to {date(l.data.to)} · {l.data.days ?? '?'} working days{l.title ? ` · ${l.title}` : ''}</div>
                            </div>
                            <button className="btn sm" onClick={() => run('leave.decide', { leaveId: l.id, approve: false })}>Decline</button>
                            <button className="btn sm primary" onClick={() => run('leave.decide', { leaveId: l.id, approve: true })}>Approve</button>
                        </li>
                    ))}
                </ul>
            </div>
            <RecordList type="leave" columns={['user', 'kind', 'from', 'to', 'days']} />
        </div>
    )
}

function Payroll()
{
    const { me, userName } = useStudio()
    const run = useRunAction()
    const now = new Date()
    const [month, setMonth] = useState(`${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`)
    const { data } = useApi<{ records: StoredRecord[] }>(`/api/records/payslip?w.month=${month}`)
    const slips = data?.records ?? []
    const total = slips.reduce((s, p) => s + Number(p.data.gross ?? 0) + Number(p.data.uifEmployer ?? 0) + Number(p.data.sdl ?? 0), 0)
    return (
        <div className="card">
            <div className="card-head">
                <div className="row">
                    <input className="input" type="month" value={month} onChange={(e) => setMonth(e.target.value)} style={{ width: 170 }} />
                    {slips.length ? <span className="muted num">Cost to company {money(total, me.currency)}</span> : null}
                </div>
                <button className="btn primary sm" onClick={() => run('payroll.draft_month', { month })}>Draft payslips</button>
            </div>
            {slips.length === 0 ? <Empty title="No payslips for this month">Drafting uses each staff member's salary and the SARS tables in Settings. Check every draft before you issue it.</Empty> : (
                <div className="table-wrap">
                    <table className="table">
                        <thead><tr><th>Person</th><th className="right">Gross</th><th className="right">PAYE</th><th className="right">UIF</th><th className="right">Net</th><th>Status</th><th /></tr></thead>
                        <tbody>
                            {slips.map((p) => (
                                <tr key={p.id} style={{ cursor: 'default' }}>
                                    <td>{userName(p.data.user)}</td>
                                    <td className="right num">{money(p.data.gross, me.currency)}</td>
                                    <td className="right num">{money(p.data.paye, me.currency)}</td>
                                    <td className="right num">{money(p.data.uif, me.currency)}</td>
                                    <td className="right num"><strong>{money(p.data.net, me.currency)}</strong></td>
                                    <td><StatusPill status={p.status} /></td>
                                    <td className="right">{p.status === 'Draft' ? <button className="btn sm" onClick={() => run('payslip.issue', { payslipId: p.id })}>Issue</button> : null}</td>
                                </tr>
                            ))}
                        </tbody>
                    </table>
                    <div className="empty small">Tax table: {slips[0]?.data.taxTable}. Covers a plain monthly salary for someone under 65.</div>
                </div>
            )}
        </div>
    )
}

export function Logins()
{
    const { me, toast, refresh } = useStudio()
    const { data, reload } = useApi<{ users: User[] }>('/api/users')
    const [adding, setAdding] = useState(false)
    const [form, setForm] = useState({ name: '', email: '', role: 'employee', password: '', githubLogin: '' })
    const [error, setError] = useState<string | null>(null)
    const save = async () => {
        try {
            await api('/api/users', { body: form })
            toast(`${form.name} can sign in now`)
            setAdding(false)
            reload()
            refresh()
        } catch (e) {
            setError((e as Error).message)
        }
    }
    const patch = async (u: User, body: Record<string, unknown>) => {
        try {
            await api(`/api/users/${u.id}`, { method: 'PATCH', body })
            reload()
            refresh()
            announceChange()
        } catch (e) {
            toast((e as Error).message, true)
        }
    }
    return (
        <div className="card">
            <div className="card-head">
                <h2>Who can sign in</h2>
                <button className="btn primary sm" onClick={() => setAdding(true)}><Icon.plus /> Add a person</button>
            </div>
            <ul className="list">
                {data?.users.map((u) => (
                    <li key={u.id}>
                        <div className="grow">
                            <strong>{u.name}</strong> {u.id === me.id ? <Pill>you</Pill> : null} {u.active === false ? <Pill tone="critical">switched off</Pill> : null}
                            <div className="small muted">{u.email} · GitHub: {u.githubLogin ? <span className="mono">{u.githubLogin}</span> : 'not linked'}</div>
                        </div>
                        <select className="select" style={{ width: 'auto' }} value={u.role} disabled={u.id === me.id} onChange={(e) => patch(u, { role: e.target.value })}>
                            <option value="manager">Manager</option>
                            <option value="employee">Employee</option>
                        </select>
                        <button className="btn sm" onClick={() => { const g = prompt('GitHub login', u.githubLogin ?? ''); if (g !== null) void patch(u, { githubLogin: g }) }}>GitHub</button>
                        {u.id !== me.id ? <button className="btn sm" onClick={() => patch(u, { active: u.active === false })}>{u.active === false ? 'Switch on' : 'Switch off'}</button> : null}
                    </li>
                ))}
            </ul>
            {adding ? (
                <Dialog title="Add a person" onClose={() => setAdding(false)} foot={<><button className="btn" onClick={() => setAdding(false)}>Cancel</button><button className="btn primary" onClick={save}>Add</button></>}>
                    {error ? <div className="error-box">{error}</div> : null}
                    <div className="form-grid">
                        <label className="field"><span>Name</span><input className="input" value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
                        <label className="field"><span>Email</span><input className="input" type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></label>
                        <label className="field"><span>Side</span>
                            <select className="select" value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}><option value="employee">Employee</option><option value="manager">Manager</option></select>
                        </label>
                        <label className="field"><span>GitHub login</span><input className="input mono" value={form.githubLogin} onChange={(e) => setForm({ ...form, githubLogin: e.target.value })} /><span className="hint">Links their commits, issues and reviews.</span></label>
                        <label className="field wide"><span>First password</span><input className="input" value={form.password} onChange={(e) => setForm({ ...form, password: e.target.value })} /><span className="hint">At least 10 characters. Tell them to change it.</span></label>
                    </div>
                </Dialog>
            ) : null}
        </div>
    )
}
