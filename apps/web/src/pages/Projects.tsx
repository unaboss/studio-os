import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { announceChange, runAction, useApi, type StoredRecord } from '../api.ts'
import { Icon } from '../icons.tsx'
import { Dialog, PageHead, RecordList, useStudio } from '../ui.tsx'

export function Projects()
{
    const [tab, setTab] = useState<'projects' | 'clients'>('projects')
    const [starting, setStarting] = useState(false)
    return (
        <>
            <PageHead title="Projects" sub="Every project runs on phases. Finishing a phase drafts its invoice; GitHub milestones and issues stay in step.">
                <button className="btn primary" onClick={() => setStarting(true)}><Icon.plus /> Start a project</button>
            </PageHead>
            <div className="tabs">
                <button className={tab === 'projects' ? 'on' : ''} onClick={() => setTab('projects')}>Projects</button>
                <button className={tab === 'clients' ? 'on' : ''} onClick={() => setTab('clients')}>Clients</button>
            </div>
            {tab === 'projects'
                ? <RecordList type="project" columns={['client', 'value', 'due', 'repo']} />
                : <RecordList type="client" columns={['contact', 'email']} />}
            {starting ? <StartProject onClose={() => setStarting(false)} /> : null}
        </>
    )
}

function StartProject({ onClose }: { onClose: () => void })
{
    const { schema, toast } = useStudio()
    const nav = useNavigate()
    const clients = useApi<{ records: StoredRecord[] }>('/api/records/client?status=Active,Prospect')
    const [form, setForm] = useState({ clientId: '', title: '', projectType: schema.projectTypes[0]?.id ?? '', value: '', repo: '', due: '' })
    const [error, setError] = useState<string | null>(null)
    const set = (k: keyof typeof form) => (e: { target: { value: string } }) => setForm({ ...form, [k]: e.target.value })
    const start = async () => {
        setError(null)
        try {
            const out = await runAction('project.start', {
                clientId: form.clientId,
                title: form.title,
                projectType: form.projectType,
                ...(form.value ? { valueCents: Math.round(Number(form.value) * 100) } : {}),
                ...(form.repo ? { repo: form.repo.trim() } : {}),
                ...(form.due ? { due: form.due } : {}),
            })
            if (out.status === 'done') {
                toast('Project started')
                announceChange()
                nav(`/records/${out.result.projectId}`)
            }
        } catch (e) {
            setError((e as Error).message)
        }
    }
    const type = schema.projectTypes.find((t) => t.id === form.projectType)
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
                <label className="field"><span>Project type *</span>
                    <select className="select" value={form.projectType} onChange={set('projectType')}>
                        {schema.projectTypes.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}
                    </select>
                    {type?.billing === 'phased' ? <span className="hint">Phases and their invoice split come from Settings.</span> : null}
                </label>
                <label className="field"><span>Value (rand)</span><input className="input num" type="number" step="0.01" value={form.value} onChange={set('value')} /></label>
                <label className="field"><span>GitHub repo</span><input className="input mono" placeholder="owner/name" value={form.repo} onChange={set('repo')} /></label>
                <label className="field"><span>Due</span><input className="input" type="date" value={form.due} onChange={set('due')} /></label>
            </div>
        </Dialog>
    )
}
