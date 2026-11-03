import { useState } from 'react'
import { announceChange, api, useApi } from '../api.ts'
import { Icon } from '../icons.tsx'
import { Dialog, Empty, PageHead, Pill, useStudio } from '../ui.tsx'

interface Condition { path: string; op: string; value?: unknown }
interface Rule { id: string; name: string; enabled: boolean; when_event: string; conditions: Condition[]; action: string; params: Record<string, unknown> }
interface Catalog
{
    rules: Rule[]
    events: string[]
    actions: { name: string; label: string; needsApproval: boolean; params: Record<string, { type: string; description: string; required?: boolean }> }[]
}

const OPS: Record<string, string> = { eq: 'is', neq: 'is not', gt: 'is more than', gte: 'is at least', lt: 'is less than', lte: 'is at most', contains: 'contains', exists: 'is set' }

/** Plain words for an event name: invoice.overdue → "an invoice is overdue". */
function eventWords(name: string): string
{
    const [type = '', what = ''] = name.split('.')
    const noun = type.replace(/_/g, ' ')
    const special: Record<string, string> = {
        created: `a ${noun} is created`,
        updated: `a ${noun} changes`,
        status_changed: `a ${noun} changes status`,
        overdue: `an ${noun} is overdue`,
        due_soon: `a ${noun} is due soon`,
        pr_merged: 'a pull request is merged',
        checks_failed: 'checks fail on GitHub',
        checks_passed: 'checks pass on GitHub',
        commit: 'someone pushes a commit',
        release: 'a release is published',
    }
    return special[what] ?? `a ${noun} becomes ${what.replace(/_/g, ' ')}`
}

export function Automations()
{
    const { data, reload } = useApi<Catalog>('/api/automations')
    const [editing, setEditing] = useState<Rule | 'new' | null>(null)
    const { toast } = useStudio()
    const toggle = async (r: Rule) => {
        await api(`/api/automations/${r.id}`, { method: 'PUT', body: { name: r.name, enabled: !r.enabled, when: r.when_event, conditions: r.conditions, action: r.action, params: r.params } })
        toast(r.enabled ? 'Rule paused' : 'Rule on')
        reload()
    }
    const label = (name: string) => data?.actions.find((a) => a.name === name)
    return (
        <>
            <PageHead title="Automations" sub="When something happens, do something. Rules that send money or messages always queue for your approval.">
                <button className="btn primary" onClick={() => setEditing('new')}><Icon.plus /> New rule</button>
            </PageHead>
            <div className="card">
                {data?.rules.length === 0 ? <Empty title="No rules yet">Try: when an invoice is overdue and days overdue is at least 7, send a payment reminder.</Empty> : null}
                <ul className="list">
                    {data?.rules.map((r) => {
                        const a = label(r.action)
                        return (
                            <li key={r.id}>
                                <div className="grow">
                                    <div className="row"><strong>{r.name}</strong>{!r.enabled ? <Pill>paused</Pill> : null}{a?.needsApproval ? <Pill tone="accent">asks first</Pill> : null}</div>
                                    <div className="small muted" style={{ marginTop: 2 }}>
                                        When {eventWords(r.when_event)}
                                        {r.conditions.map((c, i) => <span key={i}> and <span className="mono">{c.path.replace('payload.', '')}</span> {OPS[c.op] ?? c.op}{c.op !== 'exists' ? ` ${JSON.stringify(c.value)}` : ''}</span>)}
                                        , {a ? a.label.toLowerCase() : r.action}.
                                    </div>
                                </div>
                                <button className="btn sm" onClick={() => toggle(r)}>{r.enabled ? 'Pause' : 'Turn on'}</button>
                                <button className="btn sm" onClick={() => setEditing(r)}>Edit</button>
                            </li>
                        )
                    })}
                </ul>
            </div>
            {editing && data ? <RuleEditor catalog={data} rule={editing === 'new' ? null : editing} onClose={() => { setEditing(null); reload(); announceChange() }} /> : null}
        </>
    )
}

function RuleEditor({ catalog, rule, onClose }: { catalog: Catalog; rule: Rule | null; onClose: () => void })
{
    const [name, setName] = useState(rule?.name ?? '')
    const [when, setWhen] = useState(rule?.when_event ?? 'invoice.overdue')
    const [conditions, setConditions] = useState<Condition[]>(rule?.conditions ?? [])
    const [action, setAction] = useState(rule?.action ?? catalog.actions[0]?.name ?? '')
    const [params, setParams] = useState<Record<string, unknown>>(rule?.params ?? {})
    const [error, setError] = useState<string | null>(null)
    const a = catalog.actions.find((x) => x.name === action)

    const save = async () => {
        setError(null)
        const body = { name, enabled: rule?.enabled ?? true, when, conditions, action, params }
        try {
            if (rule) await api(`/api/automations/${rule.id}`, { method: 'PUT', body })
            else await api('/api/automations', { body })
            onClose()
        } catch (e) {
            setError((e as Error).message)
        }
    }
    const remove = async () => {
        if (rule && confirm(`Delete "${rule.name}"?`)) {
            await api(`/api/automations/${rule.id}`, { method: 'DELETE', body: {} })
            onClose()
        }
    }

    return (
        <Dialog
            wide
            title={rule ? 'Edit rule' : 'New rule'}
            onClose={onClose}
            foot={<>{rule ? <button className="btn danger" style={{ marginRight: 'auto' }} onClick={remove}>Delete</button> : null}<button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={save}>Save rule</button></>}
        >
            {error ? <div className="error-box">{error}</div> : null}
            <label className="field"><span>Name</span><input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Chase invoices a week late" /></label>
            <label className="field"><span>When</span>
                <select className="select" value={when} onChange={(e) => setWhen(e.target.value)}>
                    {catalog.events.map((e) => <option key={e} value={e}>{eventWords(e)} ({e})</option>)}
                </select>
            </label>
            <div className="field">
                <span>Only if</span>
                {conditions.map((c, i) => (
                    <div className="row" key={i}>
                        <input className="input mono grow" value={c.path} onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { ...x, path: e.target.value } : x)))} placeholder="payload.daysOverdue" />
                        <select className="select" style={{ width: 150 }} value={c.op} onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { ...x, op: e.target.value } : x)))}>
                            {Object.entries(OPS).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
                        </select>
                        {c.op !== 'exists' ? <input className="input" style={{ width: 140 }} value={c.value === undefined ? '' : String(c.value)} onChange={(e) => setConditions(conditions.map((x, j) => (j === i ? { ...x, value: /^-?\d+(\.\d+)?$/.test(e.target.value) ? Number(e.target.value) : e.target.value } : x)))} /> : null}
                        <button className="btn ghost sm" onClick={() => setConditions(conditions.filter((_, j) => j !== i))} aria-label="Remove condition"><Icon.x /></button>
                    </div>
                ))}
                <div><button className="btn sm" onClick={() => setConditions([...conditions, { path: 'payload.', op: 'eq', value: '' }])}><Icon.plus /> Condition</button></div>
                <span className="hint">Paths read the event: payload.record.status, payload.record.data.amount, payload.daysOverdue.</span>
            </div>
            <label className="field"><span>Then</span>
                <select className="select" value={action} onChange={(e) => { setAction(e.target.value); setParams({}) }}>
                    {catalog.actions.map((x) => <option key={x.name} value={x.name}>{x.label}{x.needsApproval ? ' (asks first)' : ''}</option>)}
                </select>
            </label>
            {a ? Object.entries(a.params).map(([k, p]) => (
                <label className="field" key={k}>
                    <span>{p.description}{p.required ? ' *' : ''}</span>
                    <input className="input mono" value={params[k] === undefined ? '' : String(params[k])} onChange={(e) => setParams({ ...params, [k]: e.target.value })} placeholder={k.endsWith('Id') ? '{{payload.record.id}}' : ''} />
                </label>
            )) : null}
            <p className="small faint">Use {'{{payload.…}}'} to pass values from the event, for example {'{{payload.invoiceId}}'}.</p>
        </Dialog>
    )
}
