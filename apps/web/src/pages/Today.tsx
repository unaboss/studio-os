import { useState } from 'react'
import { Link } from 'react-router-dom'
import { ago, announceChange, api, useApi } from '../api.ts'
import { Icon } from '../icons.tsx'
import { Empty, PageHead, Pill, Tiles, useStudio } from '../ui.tsx'

interface Approval
{
    id: string
    action: string
    params: Record<string, any>
    summary: string
    requested_by: string
    requested_by_name: string | null
    requested_via: string | null
    created_at: string
    refs?: Record<string, { id: string; title: string; type: string }>
}

interface Brief { payload: { text: string; model: string | null; proposals: { action: string; why: string; status: string }[] }; created_at: string }

function greeting(): string
{
    const h = (new Date().getUTCHours() + 2) % 24
    return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

export function Today()
{
    const { me } = useStudio()
    return (
        <>
            <PageHead title={`${greeting()}, ${me.name.split(' ')[0]}`} sub={new Date().toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long' })} />
            <AgentBrief />
            <Approvals />
            <div className="section"><Tiles side="manage" /></div>
        </>
    )
}

function AgentBrief()
{
    const { toast } = useStudio()
    const { data, reload } = useApi<{ brief: Brief | null; model: string | null }>('/api/agent/brief')
    const [running, setRunning] = useState(false)
    const run = async () => {
        setRunning(true)
        try {
            await api('/api/agent/run', { body: {} })
            reload()
            announceChange()
            toast('The agent has done its rounds')
        } catch (e) {
            toast((e as Error).message, true)
        } finally {
            setRunning(false)
        }
    }
    const brief = data?.brief
    return (
        <section className="card brief" aria-label="Morning brief">
            <div className="brief-mark"><Icon.spark /></div>
            <div className="stack" style={{ gap: 6 }}>
                <div className="spread">
                    <h2>Morning brief</h2>
                    <button className="btn sm" onClick={run} disabled={running}>{running ? 'Working…' : 'Run again'}</button>
                </div>
                <p>{brief ? brief.payload.text : 'The agent has not run yet today. It runs every morning at six, or now if you ask.'}</p>
                {brief ? (
                    <div className="meta">
                        {ago(brief.created_at)} · {brief.payload.model ? `written by ${brief.payload.model} on Vultr Serverless Inference` : 'written without a model'}
                        {(() => {
                            const n = brief.payload.proposals.filter((p) => p.status === 'pending').length
                            return n ? ` · ${n} suggestion${n === 1 ? '' : 's'} queued below` : ''
                        })()}
                    </div>
                ) : null}
            </div>
        </section>
    )
}

function Approvals()
{
    const { data, reload } = useApi<{ approvals: Approval[] }>('/api/approvals')
    const list = data?.approvals ?? []
    return (
        <section className="section">
            <div className="spread" style={{ marginBottom: 10 }}>
                <h2>Waiting for you {list.length ? <Pill tone="accent">{list.length}</Pill> : null}</h2>
                <span className="small faint">Anything that sends money or messages outside the studio stops here first.</span>
            </div>
            <div className="card">
                {list.length === 0 ? <Empty title="Nothing waiting">Invoices, reminders and refunds the agent or your rules prepare will show up here.</Empty> : null}
                {list.map((a) => <ApprovalRow key={a.id} a={a} onDone={reload} />)}
            </div>
        </section>
    )
}

function ApprovalRow({ a, onDone }: { a: Approval; onDone: () => void })
{
    const { toast } = useStudio()
    const [message, setMessage] = useState<string>(typeof a.params.message === 'string' ? a.params.message : '')
    const [editing, setEditing] = useState(false)
    const [busy, setBusy] = useState(false)
    const from = a.requested_via === 'agent' ? 'the agent' : a.requested_via?.startsWith('automation:') ? 'a rule' : a.requested_by_name ?? 'someone'
    const decide = async (approve: boolean) => {
        setBusy(true)
        try {
            const res = await api<{ approval: { status: string; result: any } }>(`/api/approvals/${a.id}`, {
                body: { approve, ...(approve && editing ? { params: { message } } : {}) },
            })
            toast(res.approval.status === 'failed' ? `It failed: ${res.approval.result?.error}` : approve ? 'Approved and done' : 'Turned down', res.approval.status === 'failed')
            onDone()
            announceChange()
        } finally {
            setBusy(false)
        }
    }
    const canWrite = a.action === 'invoice.send_reminder'
    return (
        <div className="approval">
            <div>
                <div className="row"><strong>{a.summary.split(' (')[0]}</strong><Pill>from {from}</Pill><span className="small faint">{ago(a.created_at)}</span></div>
                <div className="small muted" style={{ marginTop: 2 }}>
                    {a.refs && Object.keys(a.refs).length
                        ? Object.values(a.refs).map((r) => <Link key={r.id} to={`/records/${r.id}`} style={{ marginRight: 10 }}>{r.title}</Link>)
                        : a.summary.includes(' (') ? a.summary.slice(a.summary.indexOf(' (') + 2, -1) : null}
                </div>
                {canWrite && !editing && !message ? <div className="small faint" style={{ marginTop: 6 }}>Sends the standard, polite reminder. Edit it to write your own.</div> : null}
                {canWrite && !editing && message ? <pre>{message}</pre> : null}
                {canWrite && editing ? <textarea className="textarea" value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Leave empty for the standard reminder" /> : null}
            </div>
            <div className="row">
                {canWrite ? <button className="btn sm" onClick={() => setEditing(!editing)}>{editing ? 'Done editing' : 'Edit message'}</button> : null}
                <button className="btn sm danger" disabled={busy} onClick={() => decide(false)}><Icon.x /> No</button>
                <button className="btn sm primary" disabled={busy} onClick={() => decide(true)}><Icon.check /> Approve</button>
            </div>
        </div>
    )
}
