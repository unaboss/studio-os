import { useCallback, useEffect, useState } from 'react'

export type Tone = 'neutral' | 'good' | 'warning' | 'critical'

export interface Me
{
    id: string
    name: string
    email: string
    role: 'manager' | 'employee'
    githubLogin: string | null
    company: string
    theme: { accent: string; name: string }
    currency: string
}

export interface FieldDef
{
    key: string
    label: string
    kind: 'text' | 'longtext' | 'number' | 'money' | 'date' | 'select' | 'boolean' | 'url' | 'user' | 'users' | 'record'
    required?: boolean
    options?: string[]
    recordType?: string
    sensitive?: boolean
    custom?: boolean
}

export interface RecordType
{
    type: string
    label: string
    plural: string
    parent?: string
    fields: FieldDef[]
    statuses: string[]
    visibility?: string
    managerStatuses?: string[]
    employeeEditable?: boolean
}

export interface ActionInfo
{
    name: string
    label: string
    description: string
    params: Record<string, { type: 'string' | 'number' | 'boolean'; description: string; required?: boolean }>
    needsApproval: boolean
    managersOnly: boolean
}

export interface Schema
{
    modules: { id: string; name: string }[]
    recordTypes: RecordType[]
    actions: ActionInfo[]
    tiles: { manage: TileInfo[]; employee: TileInfo[] }
    projectTypes: { id: string; name: string; billing: string }[]
}

export interface TileInfo { id: string; title: string; size: 'sm' | 'md' | 'lg' }

export interface TileData
{
    value?: string
    caption?: string
    tone?: Tone
    items?: { label: string; detail?: string; href?: string; tone?: Tone }[]
}

export interface StoredRecord
{
    id: string
    type: string
    status: string
    title: string
    parentId: string | null
    data: Record<string, any>
    createdBy: string
    createdAt: string
    updatedAt: string
}

export interface User { id: string; name: string; role: string; githubLogin: string | null; email?: string; active?: boolean }

export type ActionOutcome =
    | { status: 'done'; result: Record<string, any> }
    | { status: 'pending'; approvalId: string; summary: string }

export class ApiError extends Error
{
    constructor(message: string, readonly status: number, readonly problems: string[] = [])
    {
        super(message)
    }
}

export async function api<T = any>(path: string, init: { method?: string; body?: unknown } = {}): Promise<T>
{
    const res = await fetch(path, {
        method: init.method ?? (init.body === undefined ? 'GET' : 'POST'),
        headers: init.body === undefined ? {} : { 'content-type': 'application/json' },
        credentials: 'same-origin',
        ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok) {
        if (res.status === 401 && !path.startsWith('/api/login')) window.dispatchEvent(new Event('studio:signed-out'))
        throw new ApiError(body.error ?? `Request failed (${res.status})`, res.status, body.problems ?? [])
    }
    return body as T
}

export const runAction = (name: string, params: Record<string, unknown>) => api<ActionOutcome>(`/api/actions/${name}`, { body: params })

/** Loads a path and reloads it when asked, or when any change elsewhere in the app announces itself. */
export function useApi<T>(path: string | null): { data: T | null; error: string | null; loading: boolean; reload: () => void }
{
    const [data, setData] = useState<T | null>(null)
    const [error, setError] = useState<string | null>(null)
    const [loading, setLoading] = useState(true)
    const [tick, setTick] = useState(0)
    const reload = useCallback(() => setTick((t) => t + 1), [])
    useEffect(() => {
        const onChange = () => setTick((t) => t + 1)
        window.addEventListener('studio:changed', onChange)
        return () => window.removeEventListener('studio:changed', onChange)
    }, [])
    useEffect(() => {
        if (!path) return
        let live = true
        setLoading(true)
        api<T>(path)
            .then((d) => {
                if (!live) return
                setData(d)
                setError(null)
            })
            .catch((e: Error) => live && setError(e.message))
            .finally(() => live && setLoading(false))
        return () => {
            live = false
        }
    }, [path, tick])
    return { data, error, loading, reload }
}

/** Tells every open view that something changed, so lists and tiles refresh. */
export const announceChange = () => window.dispatchEvent(new Event('studio:changed'))

/* ---------- Formatting ---------- */

export function money(cents: unknown, currency = 'ZAR'): string
{
    const n = Number(cents)
    if (!Number.isFinite(n)) return '—'
    const sign = n < 0 ? '-' : ''
    const abs = Math.abs(Math.round(n))
    const whole = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ' ')
    const symbol = currency === 'ZAR' ? 'R' : `${currency} `
    return `${sign}${symbol}${whole}.${String(abs % 100).padStart(2, '0')}`
}

export function date(iso: unknown): string
{
    if (typeof iso !== 'string' || !iso) return '—'
    const d = new Date(iso.length === 10 ? `${iso}T12:00:00Z` : iso)
    if (Number.isNaN(d.getTime())) return String(iso)
    return d.toLocaleDateString('en-ZA', { day: 'numeric', month: 'short', year: d.getFullYear() === new Date().getFullYear() ? undefined : 'numeric' })
}

export function ago(iso: string): string
{
    const s = (Date.now() - new Date(iso).getTime()) / 1000
    if (s < 60) return 'just now'
    if (s < 3600) return `${Math.floor(s / 60)} min ago`
    if (s < 86_400) return `${Math.floor(s / 3600)} h ago`
    if (s < 7 * 86_400) return `${Math.floor(s / 86_400)} d ago`
    return date(iso)
}

export const today = () => new Date(Date.now() + 2 * 3_600_000).toISOString().slice(0, 10)

export function statusTone(status: string): Tone
{
    const s = status.toLowerCase()
    if (['done', 'paid', 'approved', 'won', 'matched', 'issued', 'received', 'reimbursed', 'logged', 'active', 'accepted'].includes(s)) return 'good'
    if (['overdue', 'rejected', 'declined', 'lost', 'void', 'cancelled', 'failed'].includes(s)) return 'critical'
    if (['in review', 'part paid', 'submitted', 'requested', 'suggested', 'waiting', 'on hold', 'proposal sent', 'unmatched', 'sent'].includes(s)) return 'warning'
    return 'neutral'
}
