import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import
{
    announceChange,
    api,
    ApiError,
    date,
    money,
    runAction,
    statusTone,
    type ActionInfo,
    type FieldDef,
    type Me,
    type RecordType,
    type Schema,
    type StoredRecord,
    type TileData,
    type TileInfo,
    type Tone,
    type User,
} from './api.ts'
import { Icon } from './icons.tsx'

/* ---------- App-wide context ---------- */

export interface Studio
{
    me: Me
    schema: Schema
    users: User[]
    type(type: string): RecordType | undefined
    userName(id: unknown): string
    toast(message: string, error?: boolean): void
    refresh(): void
}

export const StudioContext = createContext<Studio | null>(null)

export function useStudio(): Studio
{
    const s = useContext(StudioContext)
    if (!s) throw new Error('Studio context missing')
    return s
}

/* ---------- Small pieces ---------- */

export function Pill({ children, tone }: { children: ReactNode; tone?: Tone | 'accent' })
{
    return <span className={`pill ${tone && tone !== 'neutral' ? tone : ''}`}>{children}</span>
}

export const StatusPill = ({ status }: { status: string }) => <Pill tone={statusTone(status)}>{status}</Pill>

export function Empty({ title, children }: { title: string; children?: ReactNode })
{
    return (
        <div className="empty">
            <strong>{title}</strong>
            {children}
        </div>
    )
}

export function PageHead({ title, sub, children }: { title: string; sub?: ReactNode; children?: ReactNode })
{
    return (
        <div className="page-head">
            <div>
                <h1>{title}</h1>
                {sub ? <p>{sub}</p> : null}
            </div>
            {children ? <div className="row">{children}</div> : null}
        </div>
    )
}

export function Dialog({ title, onClose, children, foot, wide }: { title: string; onClose: () => void; children: ReactNode; foot?: ReactNode; wide?: boolean })
{
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])
    return (
        <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
            <div className={`dialog ${wide ? 'wide' : ''}`} role="dialog" aria-modal="true" aria-label={title}>
                <div className="dialog-head">
                    <h2>{title}</h2>
                    <button className="btn ghost sm" onClick={onClose} aria-label="Close"><Icon.x /></button>
                </div>
                <div className="dialog-body">{children}</div>
                {foot ? <div className="dialog-foot">{foot}</div> : null}
            </div>
        </div>
    )
}

export function Tile({ info, data, error }: { info: TileInfo; data?: TileData; error?: string })
{
    const tone = data?.tone ?? 'neutral'
    return (
        <section className={`card tile ${info.size} tone-${tone}`} aria-label={info.title}>
            <div className="tile-body">
                <div className="tile-title">{info.title}</div>
                {error ? <div className="error-box small">{error}</div> : null}
                {data?.value ? <div className="tile-value">{data.value}</div> : null}
                {data?.caption ? <div className="tile-caption">{data.caption}</div> : null}
                {data?.items && data.items.length > 0 ? (
                    <ul className="tile-items">
                        {data.items.map((item, i) => (
                            <li key={i}>
                                <span className="grow">
                                    {item.tone && item.tone !== 'neutral' ? <span className={`dot ${item.tone}`} /> : null}
                                    {item.href ? (item.href.startsWith('http') ? <a href={item.href} target="_blank" rel="noreferrer">{item.label}</a> : <Link to={item.href}>{item.label}</Link>) : item.label}
                                </span>
                                {item.detail ? <span className="detail">{item.detail}</span> : null}
                            </li>
                        ))}
                    </ul>
                ) : null}
            </div>
        </section>
    )
}

export function Tiles({ side }: { side: 'manage' | 'employee' })
{
    const [tiles, setTiles] = useState<{ id: string; title: string; size: TileInfo['size']; data?: TileData; error?: string }[] | null>(null)
    const [tick, setTick] = useState(0)
    useEffect(() => {
        const on = () => setTick((t) => t + 1)
        window.addEventListener('studio:changed', on)
        return () => window.removeEventListener('studio:changed', on)
    }, [])
    useEffect(() => {
        api<{ tiles: typeof tiles }>(`/api/today?side=${side}`).then((r) => setTiles(r.tiles)).catch(() => setTiles([]))
    }, [side, tick])
    if (!tiles) return <div className="tiles">{[0, 1, 2].map((i) => <div key={i} className="card tile sm" style={{ opacity: 0.4 }} />)}</div>
    return (
        <div className="tiles">
            {tiles.map((t) => <Tile key={t.id} info={t} {...(t.data ? { data: t.data } : {})} {...(t.error ? { error: t.error } : {})} />)}
        </div>
    )
}

/* ---------- Fields ---------- */

export function FieldInput({ field, value, onChange, recordOptions }: { field: FieldDef; value: unknown; onChange: (v: unknown) => void; recordOptions?: StoredRecord[] })
{
    const { users } = useStudio()
    const id = `f-${field.key}`
    switch (field.kind) {
        case 'longtext':
            return <textarea id={id} className="textarea" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
        case 'number':
            return <input id={id} className="input num" type="number" step="any" value={value === undefined || value === null ? '' : String(value)} onChange={(e) => onChange(e.target.value === '' ? null : Number(e.target.value))} />
        case 'money':
            return (
                <input
                    id={id}
                    className="input num"
                    type="number"
                    step="0.01"
                    inputMode="decimal"
                    placeholder="0.00"
                    value={value === undefined || value === null ? '' : (Number(value) / 100).toString()}
                    onChange={(e) => onChange(e.target.value === '' ? null : Math.round(Number(e.target.value) * 100))}
                />
            )
        case 'date':
            return <input id={id} className="input" type="date" value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)} />
        case 'boolean':
            return <label className="check"><input id={id} type="checkbox" checked={!!value} onChange={(e) => onChange(e.target.checked)} /> Yes</label>
        case 'select':
            return (
                <select id={id} className="select" value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)}>
                    <option value="">Choose…</option>
                    {(field.options ?? []).map((o) => <option key={o}>{o}</option>)}
                </select>
            )
        case 'user':
            return (
                <select id={id} className="select" value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)}>
                    <option value="">Nobody</option>
                    {users.filter((u) => u.active !== false).map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
            )
        case 'users': {
            const list = Array.isArray(value) ? (value as string[]) : []
            return (
                <div className="chips">
                    {users.filter((u) => u.active !== false).map((u) => (
                        <button type="button" key={u.id} className={`chip ${list.includes(u.id) ? 'on' : ''}`} onClick={() => onChange(list.includes(u.id) ? list.filter((x) => x !== u.id) : [...list, u.id])}>
                            {u.name}
                        </button>
                    ))}
                </div>
            )
        }
        case 'record':
            if (recordOptions) {
                return (
                    <select id={id} className="select" value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)}>
                        <option value="">None</option>
                        {recordOptions.map((r) => <option key={r.id} value={r.id}>{r.title}</option>)}
                    </select>
                )
            }
            return <input id={id} className="input mono" value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)} placeholder="Record id" />
        case 'url':
            return <input id={id} className="input" type="url" placeholder="https://" value={String(value ?? '')} onChange={(e) => onChange(e.target.value || null)} />
        default:
            return <input id={id} className="input" value={String(value ?? '')} onChange={(e) => onChange(e.target.value)} />
    }
}

export function FieldValue({ field, value }: { field: FieldDef; value: unknown })
{
    const { userName, me } = useStudio()
    if (value === undefined || value === null || value === '') return <span className="faint">—</span>
    switch (field.kind) {
        case 'money': return <span className="num">{money(value, me.currency)}</span>
        case 'date': return <span>{date(value)}</span>
        case 'boolean': return <span>{value ? 'Yes' : 'No'}</span>
        case 'user': return <span>{userName(value)}</span>
        case 'users': return <span>{(value as string[]).map(userName).join(', ')}</span>
        case 'record': return <RecordLink id={String(value)} />
        case 'url': return <a href={String(value)} target="_blank" rel="noreferrer">{String(value).replace(/^https?:\/\//, '').slice(0, 48)}</a>
        case 'number': return <span className="num">{field.key === 'share' ? `${Math.round(Number(value) * 100)}%` : String(value)}</span>
        case 'longtext': return <span style={{ whiteSpace: 'pre-wrap' }}>{String(value)}</span>
        default: return <span>{String(value)}</span>
    }
}

const titles = new Map<string, Promise<string>>()

export function RecordLink({ id }: { id: string })
{
    const [title, setTitle] = useState<string | null>(null)
    useEffect(() => {
        if (!titles.has(id)) titles.set(id, api<{ record: StoredRecord }>(`/api/record/${id}`).then((r) => r.record.title).catch(() => 'Hidden record'))
        titles.get(id)!.then(setTitle)
    }, [id])
    return <Link to={`/records/${id}`}>{title ?? '…'}</Link>
}

/** Options for `record` fields: the records of that type, loaded once per form. */
export function useRecordOptions(fields: FieldDef[]): Record<string, StoredRecord[]>
{
    const [opts, setOpts] = useState<Record<string, StoredRecord[]>>({})
    const { type } = useStudio()
    const wanted = useMemo(() => [...new Set(fields.filter((f) => f.kind === 'record' && f.recordType && type(f.recordType)).map((f) => f.recordType!))], [fields, type])
    useEffect(() => {
        for (const t of wanted) {
            api<{ records: StoredRecord[] }>(`/api/records/${t}?limit=300`).then((r) => setOpts((o) => ({ ...o, [t]: r.records }))).catch(() => {})
        }
    }, [wanted.join(',')])
    return opts
}

/* ---------- Forms ---------- */

export function RecordForm({ rt, initial, onSaved, onCancel, parentId, hidden = [], defaults = {} }: {
    rt: RecordType
    initial?: StoredRecord
    parentId?: string | null
    onSaved: (r: StoredRecord) => void
    onCancel: () => void
    hidden?: string[]
    defaults?: Record<string, unknown>
})
{
    const { toast } = useStudio()
    const [title, setTitle] = useState(initial?.title ?? '')
    const [data, setData] = useState<Record<string, unknown>>({ ...defaults, ...(initial?.data ?? {}) })
    const [busy, setBusy] = useState(false)
    const [problems, setProblems] = useState<string[]>([])
    const fields = rt.fields.filter((f) => !hidden.includes(f.key) && !['fingerprint'].includes(f.key))
    const options = useRecordOptions(fields)

    const save = async () => {
        setBusy(true)
        setProblems([])
        try {
            const changed = initial ? Object.fromEntries(Object.entries(data).filter(([k, v]) => JSON.stringify(v) !== JSON.stringify(initial.data[k]))) : data
            const res = initial
                ? await api<{ record: StoredRecord }>(`/api/record/${initial.id}`, { method: 'PATCH', body: { title, data: changed } })
                : await api<{ record: StoredRecord }>(`/api/records/${rt.type}`, { body: { title, data, ...(parentId ? { parentId } : {}) } })
            toast(initial ? 'Saved' : `${rt.label} added`)
            announceChange()
            onSaved(res.record)
        } catch (e) {
            setProblems(e instanceof ApiError && e.problems.length ? e.problems : [(e as Error).message])
        } finally {
            setBusy(false)
        }
    }

    return (
        <Dialog
            title={initial ? `Edit ${rt.label.toLowerCase()}` : `New ${rt.label.toLowerCase()}`}
            onClose={onCancel}
            foot={<><button className="btn" onClick={onCancel}>Cancel</button><button className="btn primary" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button></>}
        >
            {problems.length ? <div className="error-box">{problems.map((p) => <div key={p}>{p}</div>)}</div> : null}
            <label className="field">
                <span>{rt.type === 'expense' ? 'What was it for?' : 'Title'}</span>
                <input className="input" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
            </label>
            <div className="form-grid">
                {fields.map((f) => (
                    <label key={f.key} className={`field ${['longtext', 'users'].includes(f.kind) ? 'wide' : ''}`} htmlFor={`f-${f.key}`}>
                        <span>{f.label}{f.required ? ' *' : ''}{f.custom ? <span className="hint"> · custom</span> : null}</span>
                        <FieldInput
                            field={f}
                            value={data[f.key]}
                            onChange={(v) => setData((d) => ({ ...d, [f.key]: v }))}
                            {...(f.recordType && options[f.recordType] ? { recordOptions: options[f.recordType] } : {})}
                        />
                    </label>
                ))}
            </div>
        </Dialog>
    )
}

/* ---------- Actions ---------- */

/** Runs an action and says plainly whether it happened or is waiting for approval. */
export function useRunAction(): (name: string, params: Record<string, unknown>) => Promise<boolean>
{
    const { toast } = useStudio()
    return async (name, params) => {
        try {
            const out = await runAction(name, params)
            if (out.status === 'pending') toast(`Waiting for a manager to approve: ${out.summary}`)
            else toast(describeResult(out.result))
            announceChange()
            return true
        } catch (e) {
            toast(e instanceof ApiError && e.problems.length ? e.problems.join('; ') : (e as Error).message, true)
            return false
        }
    }
}

function describeResult(r: Record<string, any>): string
{
    if (typeof r.added === 'number') return `${r.added} lines added, ${r.skipped} already there`
    if (Array.isArray(r.matched)) return r.matched.length ? `Matched ${r.matched.length} payment${r.matched.length === 1 ? '' : 's'} to invoices` : 'Nothing new to match'
    if (Array.isArray(r.created)) return `${r.created.length} drafted`
    if (r.sentTo) return `Sent to ${r.sentTo}`
    if (typeof r.added === 'number') return `${r.added} added`
    return 'Done'
}

/** Buttons for every action that takes this record's id: new modules' actions appear here for free. */
export function RecordActions({ record, exclude = [] }: { record: StoredRecord; exclude?: string[] })
{
    const { schema } = useStudio()
    const run = useRunAction()
    const [asking, setAsking] = useState<ActionInfo | null>(null)
    const key = `${record.type.replace(/_(\w)/g, (_, c: string) => c.toUpperCase())}Id`
    const actions = schema.actions.filter((a) => a.params[key] && !exclude.includes(a.name))
    if (!actions.length) return null
    return (
        <>
            {actions.map((a) => (
                <button
                    key={a.name}
                    className="btn"
                    title={a.description}
                    onClick={() => {
                        const others = Object.entries(a.params).filter(([k, p]) => k !== key && p.required)
                        if (others.length === 0) void run(a.name, { [key]: record.id })
                        else setAsking(a)
                    }}
                >
                    {a.label}{a.needsApproval ? <Pill tone="accent">approval</Pill> : null}
                </button>
            ))}
            {asking ? <ActionDialog action={asking} fixed={{ [key]: record.id }} onClose={() => setAsking(null)} /> : null}
        </>
    )
}

export function ActionDialog({ action, fixed, onClose }: { action: ActionInfo; fixed: Record<string, unknown>; onClose: () => void })
{
    const run = useRunAction()
    const [params, setParams] = useState<Record<string, unknown>>({})
    const fields = Object.entries(action.params).filter(([k]) => !(k in fixed))
    return (
        <Dialog
            title={action.label}
            onClose={onClose}
            foot={<><button className="btn" onClick={onClose}>Cancel</button><button className="btn primary" onClick={async () => (await run(action.name, { ...fixed, ...params })) && onClose()}>{action.needsApproval ? 'Ask for approval' : 'Run'}</button></>}
        >
            <p className="muted">{action.description}</p>
            {fields.map(([k, p]) => (
                <label key={k} className="field">
                    <span>{p.description}{p.required ? ' *' : ''}</span>
                    {p.type === 'boolean'
                        ? <label className="check"><input type="checkbox" checked={!!params[k]} onChange={(e) => setParams({ ...params, [k]: e.target.checked })} /> Yes</label>
                        : k === 'message'
                            ? <textarea className="textarea" value={String(params[k] ?? '')} onChange={(e) => setParams({ ...params, [k]: e.target.value })} />
                            : <input className="input" type={p.type === 'number' ? 'number' : 'text'} value={String(params[k] ?? '')} onChange={(e) => setParams({ ...params, [k]: p.type === 'number' ? Number(e.target.value) : e.target.value })} />}
                </label>
            ))}
        </Dialog>
    )
}

/* ---------- Generic list ---------- */

export function RecordTable({ rt, records, columns, onOpen }: { rt: RecordType; records: StoredRecord[]; columns: string[]; onOpen?: (r: StoredRecord) => void })
{
    const nav = useNavigate()
    const cols = columns.map((k) => rt.fields.find((f) => f.key === k)).filter((f): f is FieldDef => !!f)
    if (!records.length) return <Empty title={`No ${rt.plural.toLowerCase()} yet`} />
    return (
        <div className="table-wrap">
            <table className="table">
                <thead>
                    <tr>
                        <th>{rt.label}</th>
                        {cols.map((c) => <th key={c.key} className={c.kind === 'money' ? 'right' : ''}>{c.label}</th>)}
                        <th>Status</th>
                    </tr>
                </thead>
                <tbody>
                    {records.map((r) => (
                        <tr key={r.id} onClick={() => (onOpen ? onOpen(r) : nav(`/records/${r.id}`))}>
                            <td><strong style={{ fontWeight: 550 }}>{r.title}</strong></td>
                            {cols.map((c) => <td key={c.key} className={c.kind === 'money' ? 'right' : ''}><FieldValue field={c} value={r.data[c.key]} /></td>)}
                            <td><StatusPill status={r.status} /></td>
                        </tr>
                    ))}
                </tbody>
            </table>
        </div>
    )
}

/** A list of one record type with status filters and a New button, built from the schema. */
export function RecordList({ type, columns, query = '', hidden, defaults, title }: { type: string; columns: string[]; query?: string; hidden?: string[]; defaults?: Record<string, unknown>; title?: string })
{
    const { type: getType } = useStudio()
    const rt = getType(type)
    const [status, setStatus] = useState<string | null>(null)
    const [adding, setAdding] = useState(false)
    const [records, setRecords] = useState<StoredRecord[] | null>(null)
    const [tick, setTick] = useState(0)
    useEffect(() => {
        const on = () => setTick((t) => t + 1)
        window.addEventListener('studio:changed', on)
        return () => window.removeEventListener('studio:changed', on)
    }, [])
    useEffect(() => {
        if (!rt) return
        const q = new URLSearchParams(query)
        if (status) q.set('status', status)
        api<{ records: StoredRecord[] }>(`/api/records/${type}?${q}`).then((r) => setRecords(r.records)).catch(() => setRecords([]))
    }, [type, status, query, tick, rt])
    if (!rt) return <Empty title="This module is switched off">Switch it on in Settings.</Empty>
    return (
        <div className="card">
            <div className="card-head">
                <div className="chips">
                    <button className={`chip ${status === null ? 'on' : ''}`} onClick={() => setStatus(null)}>All</button>
                    {rt.statuses.map((s) => <button key={s} className={`chip ${status === s ? 'on' : ''}`} onClick={() => setStatus(s)}>{s}</button>)}
                </div>
                <button className="btn primary sm" onClick={() => setAdding(true)}><Icon.plus /> {title ?? `New ${rt.label.toLowerCase()}`}</button>
            </div>
            {records ? <RecordTable rt={rt} records={records} columns={columns} /> : <div className="empty">Loading…</div>}
            {adding ? <RecordForm rt={rt} onCancel={() => setAdding(false)} onSaved={() => setAdding(false)} {...(hidden ? { hidden } : {})} {...(defaults ? { defaults } : {})} /> : null}
        </div>
    )
}

export { money, date }
