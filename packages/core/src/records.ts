import { newId } from './ids.ts'
import { validateData, ValidationError } from './validate.ts'
import type { Actor, Ctx, RecordTypeDef, StoredRecord } from './types.ts'

export class NotFoundError extends Error {}
export class ForbiddenError extends Error {}

interface Row
{
    id: string
    company_id: string
    type: string
    status: string
    title: string
    parent_id: string | null
    data: Record<string, unknown>
    created_by: string
    created_at: string | Date
    updated_at: string | Date
}

const iso = (v: string | Date) => (v instanceof Date ? v.toISOString() : v)

function toRecord(r: Row): StoredRecord
{
    return {
        id: r.id,
        companyId: r.company_id,
        type: r.type,
        status: r.status,
        title: r.title,
        parentId: r.parent_id,
        data: typeof r.data === 'string' ? JSON.parse(r.data) : r.data,
        createdBy: r.created_by,
        createdAt: iso(r.created_at),
        updatedAt: iso(r.updated_at),
    }
}

/** Can this person see this record at all? */
export function canSee(actor: Actor, rt: RecordTypeDef, rec: StoredRecord): boolean
{
    if (actor.role === 'manager' || actor.kind !== 'user') return true
    const visibility = rt.visibility ?? 'everyone'
    if (visibility === 'everyone') return true
    if (visibility === 'managers') return false
    if (rec.createdBy === actor.id) return true
    const field = rt.assigneeField
    if (!field) return false
    const v = rec.data[field]
    return v === actor.id || (Array.isArray(v) && v.includes(actor.id))
}

/** Employees never receive sensitive fields (rates, salaries, bank details). */
export function redact(actor: Actor, rt: RecordTypeDef, rec: StoredRecord): StoredRecord
{
    if (actor.role === 'manager' || actor.kind !== 'user') return rec
    const hidden = rt.fields.filter((f) => f.sensitive).map((f) => f.key)
    if (hidden.length === 0) return rec
    const data = { ...rec.data }
    for (const key of hidden) delete data[key]
    return { ...rec, data }
}

export interface CreateInput
{
    readonly type: string
    readonly title: string
    readonly status?: string
    readonly parentId?: string | null
    readonly data?: Record<string, unknown>
    /** Set when a record is created by the system itself (no permission check). */
    readonly id?: string
}

export interface ListOptions
{
    readonly parentId?: string
    readonly status?: string | readonly string[]
    /** Exact match on a data field. */
    readonly where?: Readonly<Record<string, unknown>>
    readonly limit?: number
}

export class RecordStore
{
    constructor(private readonly ctx: Ctx) {}

    private type(type: string): RecordTypeDef
    {
        return this.ctx.registry.recordType(type)
    }

    async create(input: CreateInput): Promise<StoredRecord>
    {
        const rt = this.type(input.type)
        const title = input.title.trim()
        if (!title) throw new ValidationError(['A title is required'])
        if (rt.visibility === 'managers' && this.ctx.actor.kind === 'user' && this.ctx.actor.role !== 'manager') {
            throw new ForbiddenError(`Only managers can create ${rt.plural.toLowerCase()}`)
        }
        const status = input.status ?? rt.statuses[0]
        if (!status || !rt.statuses.includes(status)) throw new ValidationError([`"${input.status}" is not a status of ${rt.label}`])
        const data = validateData(rt, input.data ?? {})
        const id = input.id ?? newId(rt.type.slice(0, 4))
        const rows = await this.ctx.db.query<Row>(
            `insert into records (id, company_id, type, status, title, parent_id, data, created_by)
             values ($1, $2, $3, $4, $5, $6, $7::jsonb, $8) returning *`,
            [id, this.ctx.companyId, rt.type, status, title, input.parentId ?? null, JSON.stringify(data), this.ctx.actor.id],
        )
        const rec = toRecord(rows[0]!)
        await this.ctx.events.emit(`${rt.type}.created`, { recordId: rec.id, payload: { record: rec } })
        return rec
    }

    /** Reads a record, checking visibility and hiding sensitive fields. */
    async get(id: string): Promise<StoredRecord>
    {
        const rec = await this.getRaw(id)
        const rt = this.type(rec.type)
        if (!canSee(this.ctx.actor, rt, rec)) throw new NotFoundError('Record not found')
        return redact(this.ctx.actor, rt, rec)
    }

    /** Reads a record with no permission checks, for system code only. */
    async getRaw(id: string): Promise<StoredRecord>
    {
        const rows = await this.ctx.db.query<Row>('select * from records where id = $1 and company_id = $2', [id, this.ctx.companyId])
        if (!rows[0]) throw new NotFoundError('Record not found')
        return toRecord(rows[0])
    }

    async list(type: string, opts: ListOptions = {}): Promise<StoredRecord[]>
    {
        const rt = this.type(type)
        const params: unknown[] = [this.ctx.companyId, type]
        const where = ['company_id = $1', 'type = $2']
        if (opts.parentId) {
            params.push(opts.parentId)
            where.push(`parent_id = $${params.length}`)
        }
        if (opts.status) {
            params.push(Array.isArray(opts.status) ? opts.status : [opts.status])
            where.push(`status = any($${params.length}::text[])`)
        }
        for (const [key, value] of Object.entries(opts.where ?? {})) {
            params.push(JSON.stringify({ [key]: value }))
            where.push(`data @> $${params.length}::jsonb`)
        }
        const rows = await this.ctx.db.query<Row>(
            `select * from records where ${where.join(' and ')} order by created_at desc limit ${Math.min(opts.limit ?? 500, 2000)}`,
            params,
        )
        return rows
            .map(toRecord)
            .filter((r) => canSee(this.ctx.actor, rt, r))
            .map((r) => redact(this.ctx.actor, rt, r))
    }

    async update(id: string, patch: { title?: string; status?: string; data?: Record<string, unknown> }): Promise<StoredRecord>
    {
        const before = await this.getRaw(id)
        const rt = this.type(before.type)
        if (!canSee(this.ctx.actor, rt, before)) throw new NotFoundError('Record not found')
        const changes = validateData(rt, patch.data ?? {}, true)
        if (this.ctx.actor.kind === 'user' && this.ctx.actor.role !== 'manager') {
            const touched = rt.fields.filter((f) => f.sensitive && f.key in changes)
            if (touched.length > 0) throw new ForbiddenError(`Only managers can change ${touched.map((f) => f.label).join(', ')}`)
        }
        const status = patch.status ?? before.status
        if (!rt.statuses.includes(status)) throw new ValidationError([`"${status}" is not a status of ${rt.label}`])
        const title = patch.title?.trim() || before.title
        const data = { ...before.data, ...changes }
        const rows = await this.ctx.db.query<Row>(
            `update records set title = $1, status = $2, data = $3::jsonb, updated_at = now()
             where id = $4 and company_id = $5 returning *`,
            [title, status, JSON.stringify(data), id, this.ctx.companyId],
        )
        const after = toRecord(rows[0]!)
        await this.ctx.events.emit(`${rt.type}.updated`, { recordId: id, payload: { record: after, changes } })
        if (status !== before.status) {
            const payload = { record: after, from: before.status, to: status }
            await this.ctx.events.emit(`${rt.type}.status_changed`, { recordId: id, payload })
            await this.ctx.events.emit(`${rt.type}.${slug(status)}`, { recordId: id, payload })
        }
        return redact(this.ctx.actor, rt, after)
    }

    async setStatus(id: string, status: string): Promise<StoredRecord>
    {
        return this.update(id, { status })
    }

    async children(parentId: string, type?: string): Promise<StoredRecord[]>
    {
        const parent = await this.getRaw(parentId)
        const types = type ? [type] : this.ctx.registry.recordTypes().filter((t) => t.parent === parent.type).map((t) => t.type)
        const all = await Promise.all(types.map((t) => this.list(t, { parentId })))
        return all.flat()
    }
}

/** `In review` → `in_review`, used in event names. */
export function slug(s: string): string
{
    return s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '')
}
