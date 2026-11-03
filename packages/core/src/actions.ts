import { newId } from './ids.ts'
import { ForbiddenError, NotFoundError } from './records.ts'
import { ValidationError } from './validate.ts'
import type { ActionDef, Ctx } from './types.ts'

export interface RequestOptions
{
    /** Where the request came from: `ui`, `agent`, `automation:<id>`. */
    readonly via?: string
    /** Requested by a rule or the agent, never by a person directly. */
    readonly automated?: boolean
}

export type ActionOutcome =
    | { readonly status: 'done'; readonly result: Record<string, unknown> }
    | { readonly status: 'pending'; readonly approvalId: string; readonly summary: string }

export interface ApprovalRow
{
    id: string
    action: string
    params: Record<string, unknown>
    summary: string
    requested_by: string
    requested_via: string | null
    status: 'pending' | 'approved' | 'rejected' | 'failed'
    decided_by: string | null
    result: Record<string, unknown> | null
    created_at: string
}

/**
 * Runs actions by name for the UI, automations and the agent alike.
 * Anything that sends money or messages outside the company waits in the
 * approval queue unless a manager is the one asking for it directly.
 */
export class ActionRunner
{
    constructor(private readonly ctx: Ctx) {}

    async request(name: string, params: Record<string, unknown>, opts: RequestOptions = {}): Promise<ActionOutcome>
    {
        const action = this.ctx.registry.action(name)
        checkParams(action, params)
        const actor = this.ctx.actor
        const isManagerByHand = actor.kind === 'user' && actor.role === 'manager' && !opts.automated
        if (action.managersOnly && actor.kind === 'user' && actor.role !== 'manager') {
            throw new ForbiddenError(`Only managers can ${action.label.toLowerCase()}`)
        }
        if (action.needsApproval && !isManagerByHand) {
            const id = newId('appr')
            const summary = describe(action, params)
            await this.ctx.db.query(
                `insert into approvals (id, company_id, action, params, summary, requested_by, requested_via)
                 values ($1, $2, $3, $4::jsonb, $5, $6, $7)`,
                [id, this.ctx.companyId, name, JSON.stringify(params), summary, actor.id, opts.via ?? null],
            )
            await this.ctx.events.emit('approval.requested', { payload: { approvalId: id, action: name, summary } })
            return { status: 'pending', approvalId: id, summary }
        }
        const result = await action.run(this.ctx, params)
        await this.ctx.events.emit('action.ran', { payload: { action: name, params, via: opts.via ?? 'ui' } })
        return { status: 'done', result }
    }

    async pending(): Promise<ApprovalRow[]>
    {
        return this.ctx.db.query<ApprovalRow>(
            `select * from approvals where company_id = $1 and status = 'pending' order by created_at`,
            [this.ctx.companyId],
        )
    }

    async decide(approvalId: string, approve: boolean): Promise<ApprovalRow>
    {
        const actor = this.ctx.actor
        if (actor.kind !== 'user' || actor.role !== 'manager') throw new ForbiddenError('Only managers can approve')
        const rows = await this.ctx.db.query<ApprovalRow>(
            `select * from approvals where id = $1 and company_id = $2 and status = 'pending'`,
            [approvalId, this.ctx.companyId],
        )
        const row = rows[0]
        if (!row) throw new NotFoundError('Approval not found or already decided')
        const params = typeof row.params === 'string' ? JSON.parse(row.params) : row.params
        let status: ApprovalRow['status'] = approve ? 'approved' : 'rejected'
        let result: Record<string, unknown> | null = null
        if (approve) {
            try {
                result = await this.ctx.registry.action(row.action).run(this.ctx, params)
            } catch (err) {
                status = 'failed'
                result = { error: err instanceof Error ? err.message : String(err) }
            }
        }
        const updated = await this.ctx.db.query<ApprovalRow>(
            `update approvals set status = $1, decided_by = $2, decided_at = now(), result = $3::jsonb
             where id = $4 and company_id = $5 returning *`,
            [status, actor.id, JSON.stringify(result), approvalId, this.ctx.companyId],
        )
        await this.ctx.events.emit(`approval.${status}`, { payload: { approvalId, action: row.action, result } })
        return updated[0]!
    }
}

function checkParams(action: ActionDef, params: Record<string, unknown>): void
{
    const problems: string[] = []
    for (const [key, def] of Object.entries(action.params)) {
        const v = params[key]
        if (v === undefined || v === null || v === '') {
            if (def.required) problems.push(`${key} is required`)
            continue
        }
        if (typeof v !== def.type) problems.push(`${key} must be a ${def.type}`)
    }
    if (problems.length > 0) throw new ValidationError(problems.map((p) => `${action.label}: ${p}`))
}

function describe(action: ActionDef, params: Record<string, unknown>): string
{
    const detail = Object.entries(params)
        .filter(([, v]) => v !== undefined && v !== null && v !== '')
        .map(([k, v]) => `${k}: ${typeof v === 'string' && v.length > 60 ? `${v.slice(0, 57)}...` : String(v)}`)
        .join(', ')
    return detail ? `${action.label} (${detail})` : action.label
}
