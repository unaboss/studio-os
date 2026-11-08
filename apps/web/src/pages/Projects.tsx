import { useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ago, announceChange, runAction, useApi, type StoredRecord } from '../api.ts'
import { Icon } from '../icons.tsx'
import { Dialog, Empty, PageHead, useStudio } from '../ui.tsx'
import type { RepoRow } from './CodeTree.tsx'

/** Every project grouped by its client, each with its code health and a way into its tree. */
export function Projects()
{
    const { me } = useStudio()
    const [starting, setStarting] = useState(false)
    const projects = useApi<{ records: StoredRecord[] }>('/api/records/project?limit=500')
    const clients = useApi<{ records: StoredRecord[] }>('/api/records/client?limit=500')
    const code = useApi<{ repos: RepoRow[] }>('/api/code')
    const byProject = new Map((code.data?.repos ?? []).map((r) => [r.projectId, r]))
    const list = (projects.data?.records ?? []).filter((p) => !['Cancelled'].includes(p.status))
    const groups = new Map<string, StoredRecord[]>()
    for (const p of list) {
        const k = String(p.data.client ?? '')
        groups.set(k, [...(groups.get(k) ?? []), p])
    }
    const clientName = (id: string) => clients.data?.records.find((c) => c.id === id)?.title ?? 'No client'
    const order = [...groups.keys()].sort((a, b) => clientName(a).localeCompare(clientName(b)))
    return (
        <>
            <PageHead title="Projects" sub="Every project by client. The dot is the code's health: failing checks, branches left open, reviews waiting.">
                {me.role === 'manager' ? <button className="btn primary" onClick={() => setStarting(true)}><Icon.plus /> Start a project</button> : null}
            </PageHead>
            {projects.data && !list.length ? <Empty title="No projects yet">Start one and link its GitHub repo to grow its tree.</Empty> : null}
            <div className="stack">
                {order.map((cid) => (
                    <section key={cid} className="card">
                        <div className="card-head"><h2>{clientName(cid)}</h2><span className="small faint">{groups.get(cid)!.length} {groups.get(cid)!.length === 1 ? 'project' : 'projects'}</span></div>
                        <ul className="list project-rows">
                            {groups.get(cid)!.map((p) => {
                                const r = byProject.get(p.id)
                                return (
                                    <li key={p.id}>
                                        <span className={`health ${r?.health ?? 'none'}`} title={r?.reasons?.join('\n') || ''} />
                                        <div className="grow">
                                            <Link to={`/records/${p.id}`}><strong>{p.title}</strong></Link>
                                            <div className="small faint">
                                                {p.status}
                                                {r ? <> · <span className="mono">{r.repo}</span> · {r.openBranches ?? 0} open {(r.openBranches ?? 0) === 1 ? 'branch' : 'branches'}{r.lastCommit ? ` · last commit ${ago(r.lastCommit)}` : ''}</> : ' · no repo linked'}
                                            </div>
                                            {r?.reasons?.length ? <div className="small muted">{r.reasons.join(' · ')}</div> : null}
                                        </div>
                                        {r ? <Link className="btn sm" to={`/code?repo=${encodeURIComponent(r.repo)}`}><Icon.tree /> Tree</Link> : null}
                                    </li>
                                )
                            })}
                        </ul>
                    </section>
                ))}
            </div>
            {starting ? <StartProject onClose={() => setStarting(false)} /> : null}
        </>
    )
}

function StartProject({ onClose }: { onClose: () => void })
{
    const { schema, toast } = useStudio()
    const nav = useNavigate()
    const clients = useApi<{ records: StoredRecord[] }>('/api/records/client?status=Active,Prospect')
    const [form, setForm] = useState({ clientId: '', title: '', repo: '', due: '' })
    const [error, setError] = useState<string | null>(null)
    const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
    const start = async () => {
        setError(null)
        try {
            const out = await runAction('project.start', {
                clientId: form.clientId,
                title: form.title,
                projectType: schema.projectTypes[0]?.id ?? '',
                ...(form.repo ? { repo: form.repo.trim() } : {}),
                ...(form.due ? { due: form.due } : {}),
            })
            if (out.status === 'done') {
                toast('Project started')
                announceChange()
                nav(form.repo ? `/code?repo=${encodeURIComponent(form.repo.trim())}` : `/records/${out.result.projectId}`)
            }
        } catch (e) {
            setError((e as Error).message)
        }
    }
    return (
        <Dialog title="Start a project" onClose={onClose} foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={start}>Start</button></>}>
            {error ? <div className="error-box">{error}</div> : null}
            <label className="field"><span>Client *</span>
                <select className="select" value={form.clientId} onChange={set('clientId')}>
                    <option value="">Choose a client…</option>
                    {clients.data?.records.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
                </select>
            </label>
            <label className="field"><span>Project name *</span><input className="input" value={form.title} onChange={set('title')} /></label>
            <div className="form-grid">
                <label className="field"><span>GitHub repo</span><input className="input mono" placeholder="owner/name" value={form.repo} onChange={set('repo')} /></label>
                <label className="field"><span>Due</span><input className="input" type="date" value={form.due} onChange={set('due')} /></label>
            </div>
        </Dialog>
    )
}
