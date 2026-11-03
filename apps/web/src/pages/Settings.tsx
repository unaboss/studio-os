import { useEffect, useState } from 'react'
import { announceChange, api } from '../api.ts'
import { Icon } from '../icons.tsx'
import { Empty, PageHead, Pill, useStudio } from '../ui.tsx'

interface FieldDef { key: string; label: string; kind: string; options?: string[]; required?: boolean }
interface ProjectType { id: string; name: string; billing: 'phased' | 'retainer' | 'hourly'; phases: { name: string; share: number }[] }
interface Config
{
    currency: string
    modules: string[]
    fields: Record<string, FieldDef[]>
    statuses: Record<string, string[]>
    projectTypes: ProjectType[]
    layouts: { manage: string[]; employee: string[] }
    theme: { accent: string; name: string }
    paymentTermsDays?: number
    settings?: Record<string, Record<string, any>>
}
interface Installed { id: string; name: string; description: string; required: boolean; dependsOn: string[]; records: { type: string; label: string; statuses: string[]; fields: string[] }[]; tiles: { id: string; title: string; sides: string[] }[] }
interface SettingsData { name: string; config: Config; installed: Installed[]; integrations: { github: boolean; githubWebhook: boolean; inference: string | null; sandbox: boolean; mail: boolean } }

type Tab = 'company' | 'modules' | 'fields' | 'types' | 'layout' | 'integrations'

const KINDS = ['text', 'longtext', 'number', 'money', 'date', 'select', 'boolean', 'url', 'user']

/**
 * Everything that makes Studio OS fit a particular studio lives here, as
 * data. Saving rebuilds the company's registry; a config that would break it
 * is refused before it is stored.
 */
export function Settings()
{
    const { toast, refresh } = useStudio()
    const [data, setData] = useState<SettingsData | null>(null)
    const [config, setConfig] = useState<Config | null>(null)
    const [name, setName] = useState('')
    const [tab, setTab] = useState<Tab>('company')
    const [dirty, setDirty] = useState(false)
    const load = () => api<SettingsData>('/api/settings').then((d) => { setData(d); setConfig(d.config); setName(d.name); setDirty(false) })
    useEffect(() => { void load() }, [])
    if (!data || !config) return <div className="empty">Loading…</div>

    const update = (c: Config) => { setConfig(c); setDirty(true) }
    const save = async () => {
        try {
            await api('/api/settings', { method: 'PUT', body: { config, name } })
            toast('Settings saved')
            await load()
            refresh()
            announceChange()
        } catch (e) {
            toast((e as Error).message, true)
        }
    }

    return (
        <>
            <PageHead title="Settings" sub="Shape Studio OS around how your studio works. No code, no redeploy.">
                {dirty ? <button className="btn" onClick={() => load()}>Undo changes</button> : null}
                <button className="btn primary" disabled={!dirty} onClick={save}>Save</button>
            </PageHead>
            <div className="tabs">
                {([['company', 'Company'], ['modules', 'Modules'], ['fields', 'Fields and statuses'], ['types', 'Project types'], ['layout', 'Screens'], ['integrations', 'Connections']] as [Tab, string][]).map(([t, l]) => (
                    <button key={t} className={tab === t ? 'on' : ''} onClick={() => setTab(t)}>{l}</button>
                ))}
            </div>
            {tab === 'company' ? <Company config={config} update={update} name={name} setName={(n) => { setName(n); setDirty(true) }} /> : null}
            {tab === 'modules' ? <Modules config={config} update={update} installed={data.installed} /> : null}
            {tab === 'fields' ? <Fields config={config} update={update} installed={data.installed} /> : null}
            {tab === 'types' ? <ProjectTypes config={config} update={update} /> : null}
            {tab === 'layout' ? <Layout config={config} update={update} installed={data.installed} /> : null}
            {tab === 'integrations' ? <Integrations i={data.integrations} /> : null}
        </>
    )
}

type Props = { config: Config; update: (c: Config) => void }

function Company({ config, update, name, setName }: Props & { name: string; setName: (n: string) => void })
{
    const s = config.settings ?? {}
    const setS = (mod: string, key: string, value: unknown) => update({ ...config, settings: { ...s, [mod]: { ...(s[mod] ?? {}), [key]: value } } })
    return (
        <div className="card card-pad">
            <div className="form-grid">
                <label className="field"><span>Company name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} /></label>
                <label className="field"><span>Name on screens and emails</span><input className="input" value={config.theme.name} onChange={(e) => update({ ...config, theme: { ...config.theme, name: e.target.value } })} /></label>
                <label className="field"><span>Brand colour</span>
                    <div className="row"><input type="color" value={config.theme.accent} onChange={(e) => update({ ...config, theme: { ...config.theme, accent: e.target.value } })} style={{ width: 48, height: 38, border: 0, background: 'none' }} /><span className="mono">{config.theme.accent}</span></div>
                </label>
                <label className="field"><span>Payment terms (days)</span><input className="input num" type="number" value={config.paymentTermsDays ?? 14} onChange={(e) => update({ ...config, paymentTermsDays: Number(e.target.value) })} /></label>
                <label className="field"><span>Financial year ends in</span>
                    <select className="select" value={s.compliance?.yearEndMonth ?? 2} onChange={(e) => setS('compliance', 'yearEndMonth', Number(e.target.value))}>
                        {['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'].map((m, i) => <option key={m} value={i + 1}>{m}</option>)}
                    </select>
                </label>
                <label className="field"><span>Incorporated on</span><input className="input" type="date" value={s.compliance?.incorporated ?? ''} onChange={(e) => setS('compliance', 'incorporated', e.target.value)} /><span className="hint">For the CIPC annual return.</span></label>
                <label className="field"><span>VAT</span>
                    <select className="select" value={s.compliance?.vatRegistered ? (s.compliance?.vatPeriods ?? 'odd') : 'no'} onChange={(e) => update({ ...config, settings: { ...s, compliance: { ...(s.compliance ?? {}), vatRegistered: e.target.value !== 'no', vatPeriods: e.target.value === 'even' ? 'even' : 'odd' } } })}>
                        <option value="no">Not registered</option>
                        <option value="odd">Every two months, periods ending Jan, Mar, May…</option>
                        <option value="even">Every two months, periods ending Feb, Apr, Jun…</option>
                    </select>
                </label>
                <label className="field"><span>Payday</span><input className="input num" type="number" min={1} max={31} value={s.people?.payday ?? 25} onChange={(e) => setS('people', 'payday', Number(e.target.value))} /></label>
                <label className="field"><span>Agent morning round at</span>
                    <select className="select" value={s.agent?.hour ?? 6} onChange={(e) => setS('agent', 'hour', Number(e.target.value))}>
                        {[5, 6, 7, 8, 9].map((h) => <option key={h} value={h}>{String(h).padStart(2, '0')}:00</option>)}
                    </select>
                </label>
                <label className="field"><span>Invoice number prefix</span><input className="input mono" value={s.money?.invoicePrefix ?? 'INV-'} onChange={(e) => setS('money', 'invoicePrefix', e.target.value)} /></label>
            </div>
        </div>
    )
}

function Modules({ config, update, installed }: Props & { installed: Installed[] })
{
    const isOn = (m: Installed) => m.required || config.modules.includes(m.id)
    const neededBy = (m: Installed) => installed.filter((x) => isOn(x) && x.dependsOn.includes(m.id)).map((x) => x.name)
    return (
        <div className="card">
            <ul className="list">
                {installed.map((m) => {
                    const needs = neededBy(m)
                    return (
                        <li key={m.id}>
                            <div className="grow">
                                <div className="row"><strong>{m.name}</strong>{m.required ? <Pill>always on</Pill> : null}</div>
                                <div className="small muted">{m.description} {m.records.length ? `Adds ${m.records.map((r) => r.label.toLowerCase()).join(', ')}.` : ''}</div>
                                {needs.length && !m.required ? <div className="small faint">Needed by {needs.join(', ')}</div> : null}
                            </div>
                            <label className="check">
                                <input
                                    type="checkbox"
                                    checked={isOn(m)}
                                    disabled={m.required || (isOn(m) && needs.length > 0)}
                                    onChange={(e) => update({ ...config, modules: e.target.checked ? [...config.modules, m.id] : config.modules.filter((x) => x !== m.id) })}
                                />
                                {isOn(m) ? 'On' : 'Off'}
                            </label>
                        </li>
                    )
                })}
            </ul>
            <div className="empty small">Switching a module off hides it; its records stay in the database and come back when you switch it on.</div>
        </div>
    )
}

function Fields({ config, update, installed }: Props & { installed: Installed[] })
{
    const types = installed.filter((m) => m.required || config.modules.includes(m.id)).flatMap((m) => m.records)
    const [type, setType] = useState(types[0]?.type ?? 'client')
    const rt = types.find((t) => t.type === type)
    const custom = config.fields[type] ?? []
    const statuses = config.statuses[type] ?? rt?.statuses ?? []
    const setFields = (list: FieldDef[]) => update({ ...config, fields: { ...config.fields, [type]: list } })
    const setStatuses = (list: string[]) => update({ ...config, statuses: { ...config.statuses, [type]: list } })
    return (
        <div className="stack">
            <div className="row">
                <span className="muted">Record type</span>
                <select className="select" style={{ width: 'auto' }} value={type} onChange={(e) => setType(e.target.value)}>
                    {types.map((t) => <option key={t.type} value={t.type}>{t.label}</option>)}
                </select>
            </div>
            <div className="card">
                <div className="card-head"><h2>Your own fields</h2><button className="btn sm" onClick={() => setFields([...custom, { key: '', label: '', kind: 'text' }])}><Icon.plus /> Field</button></div>
                {custom.length === 0 ? <Empty title="No custom fields">Built in: {rt?.fields.join(', ')}. Add your own, like a VAT number on clients or a cost centre on projects.</Empty> : null}
                <ul className="list">
                    {custom.map((f, i) => {
                        const set = (patch: Partial<FieldDef>) => setFields(custom.map((x, j) => (j === i ? { ...x, ...patch } : x)))
                        return (
                            <li key={i} style={{ flexWrap: 'wrap' }}>
                                <input className="input" style={{ width: 200 }} placeholder="Label" value={f.label} onChange={(e) => set({ label: e.target.value, key: f.key || '' })} onBlur={() => !f.key && set({ key: f.label.toLowerCase().replace(/[^a-z0-9]+(.)/g, (_, c: string) => c.toUpperCase()).replace(/[^a-zA-Z0-9]/g, '') })} />
                                <input className="input mono" style={{ width: 150 }} placeholder="key" value={f.key} onChange={(e) => set({ key: e.target.value.replace(/[^a-zA-Z0-9]/g, '') })} />
                                <select className="select" style={{ width: 130 }} value={f.kind} onChange={(e) => set({ kind: e.target.value })}>{KINDS.map((k) => <option key={k}>{k}</option>)}</select>
                                {f.kind === 'select' ? <input className="input grow" placeholder="Options, comma separated" value={(f.options ?? []).join(', ')} onChange={(e) => set({ options: e.target.value.split(',').map((x) => x.trim()).filter(Boolean) })} /> : <span className="grow" />}
                                <label className="check small"><input type="checkbox" checked={!!f.required} onChange={(e) => set({ required: e.target.checked })} /> Required</label>
                                <button className="btn ghost sm" onClick={() => setFields(custom.filter((_, j) => j !== i))} aria-label="Remove"><Icon.x /></button>
                            </li>
                        )
                    })}
                </ul>
            </div>
            <div className="card card-pad">
                <h2 style={{ marginBottom: 6 }}>Statuses</h2>
                <p className="small muted" style={{ marginBottom: 10 }}>Rename or add steps. The first one is where new records start. Rules and GitHub sync use the names, so check your automations after renaming.</p>
                <input className="input" value={statuses.join(', ')} onChange={(e) => setStatuses(e.target.value.split(',').map((s) => s.trim()).filter(Boolean))} />
                {config.statuses[type] ? <button className="btn ghost sm" style={{ marginTop: 8 }} onClick={() => { const { [type]: _, ...rest } = config.statuses; update({ ...config, statuses: rest }) }}>Back to the defaults</button> : null}
            </div>
        </div>
    )
}

function ProjectTypes({ config, update }: Props)
{
    const set = (i: number, t: ProjectType) => update({ ...config, projectTypes: config.projectTypes.map((x, j) => (j === i ? t : x)) })
    return (
        <div className="stack">
            {config.projectTypes.map((t, i) => {
                const total = t.phases.reduce((s, p) => s + p.share, 0)
                return (
                    <div className="card card-pad" key={i}>
                        <div className="row" style={{ marginBottom: 10 }}>
                            <input className="input grow" value={t.name} onChange={(e) => set(i, { ...t, name: e.target.value })} />
                            <input className="input mono" style={{ width: 120 }} value={t.id} onChange={(e) => set(i, { ...t, id: e.target.value.replace(/[^a-z0-9-]/g, '') })} />
                            <select className="select" style={{ width: 140 }} value={t.billing} onChange={(e) => set(i, { ...t, billing: e.target.value as ProjectType['billing'] })}>
                                <option value="phased">Phased</option><option value="retainer">Retainer</option><option value="hourly">Hourly</option>
                            </select>
                            <button className="btn ghost sm" onClick={() => update({ ...config, projectTypes: config.projectTypes.filter((_, j) => j !== i) })} aria-label="Remove type"><Icon.x /></button>
                        </div>
                        {t.billing === 'phased' ? (
                            <>
                                {t.phases.map((p, k) => (
                                    <div className="row" key={k} style={{ marginBottom: 6 }}>
                                        <span className="faint small" style={{ width: 18 }}>{k + 1}</span>
                                        <input className="input grow" value={p.name} onChange={(e) => set(i, { ...t, phases: t.phases.map((x, m) => (m === k ? { ...x, name: e.target.value } : x)) })} />
                                        <input className="input num" style={{ width: 90 }} type="number" value={Math.round(p.share * 100)} onChange={(e) => set(i, { ...t, phases: t.phases.map((x, m) => (m === k ? { ...x, share: Number(e.target.value) / 100 } : x)) })} />
                                        <span className="faint">%</span>
                                        <button className="btn ghost sm" onClick={() => set(i, { ...t, phases: t.phases.filter((_, m) => m !== k) })} aria-label="Remove phase"><Icon.x /></button>
                                    </div>
                                ))}
                                <div className="spread">
                                    <button className="btn sm" onClick={() => set(i, { ...t, phases: [...t.phases, { name: 'New phase', share: 0 }] })}><Icon.plus /> Phase</button>
                                    <span className={`small ${Math.abs(total - 1) > 0.001 ? '' : 'faint'}`} style={Math.abs(total - 1) > 0.001 ? { color: 'var(--warning)' } : {}}>Adds up to {Math.round(total * 100)}%</span>
                                </div>
                            </>
                        ) : <p className="small muted">{t.billing === 'retainer' ? 'Invoiced monthly; no phases.' : 'Invoiced from logged billable time.'}</p>}
                    </div>
                )
            })}
            <div><button className="btn" onClick={() => update({ ...config, projectTypes: [...config.projectTypes, { id: `type-${config.projectTypes.length + 1}`, name: 'New project type', billing: 'phased', phases: [{ name: 'Deposit', share: 0.5 }, { name: 'Delivery', share: 0.5 }] }] })}><Icon.plus /> Project type</button></div>
        </div>
    )
}

function Layout({ config, update, installed }: Props & { installed: Installed[] })
{
    const on = installed.filter((m) => m.required || config.modules.includes(m.id))
    const all = on.flatMap((m) => m.tiles)
    const side = (s: 'manage' | 'employee') => {
        const available = all.filter((t) => t.sides.includes(s))
        const order = config.layouts[s].filter((id) => available.some((t) => t.id === id))
        const hidden = available.filter((t) => !order.includes(t.id))
        const setOrder = (list: string[]) => update({ ...config, layouts: { ...config.layouts, [s]: list } })
        const move = (i: number, d: number) => {
            const list = [...order]
            const [x] = list.splice(i, 1)
            list.splice(i + d, 0, x!)
            setOrder(list)
        }
        return (
            <div className="card">
                <div className="card-head"><h2>{s === 'manage' ? 'Manager Today page' : "Employee My day"}</h2></div>
                <ul className="list">
                    {order.map((id, i) => (
                        <li key={id}>
                            <span className="grow">{available.find((t) => t.id === id)?.title}</span>
                            <button className="btn ghost sm" disabled={i === 0} onClick={() => move(i, -1)} aria-label="Move up"><Icon.up /></button>
                            <button className="btn ghost sm" disabled={i === order.length - 1} onClick={() => move(i, 1)} aria-label="Move down"><Icon.down /></button>
                            <button className="btn sm" onClick={() => setOrder(order.filter((x) => x !== id))}>Hide</button>
                        </li>
                    ))}
                    {hidden.map((t) => (
                        <li key={t.id} style={{ opacity: 0.6 }}>
                            <span className="grow">{t.title}</span>
                            <button className="btn sm" onClick={() => setOrder([...order, t.id])}>Show</button>
                        </li>
                    ))}
                </ul>
            </div>
        )
    }
    return <div className="stack">{side('manage')}{side('employee')}</div>
}

function Integrations({ i }: { i: SettingsData['integrations'] })
{
    const row = (name: string, on: boolean, detail: string, how: string) => (
        <li>
            <div className="grow"><strong>{name}</strong><div className="small muted">{on ? detail : how}</div></div>
            <Pill tone={on ? 'good' : 'neutral'}>{on ? 'Connected' : 'Not set up'}</Pill>
        </li>
    )
    return (
        <div className="card">
            <ul className="list">
                {row('Vultr Serverless Inference', !!i.inference, `The agent writes briefs, reminders and statement readers with ${i.inference}.`, 'Set VULTR_INFERENCE_API_KEY on the server. Without it the agent still runs, without writing.')}
                {row('Sandbox', i.sandbox, 'Code the agent writes runs in a separate container with no network.', 'Runs as its own container in docker compose.')}
                {row('GitHub', i.github, 'Tasks create issues, phases create milestones, finishing closes them.', 'Set GITHUB_TOKEN (a fine-grained token with Issues read and write on your repos).')}
                {row('GitHub webhook', i.githubWebhook, 'Issues, pull requests, reviews, commits and checks flow in. Point the repo webhook at /api/github/webhook.', 'Set GITHUB_WEBHOOK_SECRET, then add the webhook to each repo.')}
                {row('Email', i.mail, 'Invoices and approved reminders are emailed.', 'Without a mail key, emails go to the Activity outbox instead of being sent.')}
            </ul>
        </div>
    )
}
