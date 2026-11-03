import { ActionRunner } from './actions.ts'
import { SYSTEM } from './actors.ts'
import { fillParams, ruleMatches, toRule, type AutomationRow } from './automations.ts'
import { RecordStore } from './records.ts'
import type { Ctx, StudioEvent } from './types.ts'

/** Stops a rule that triggers itself from looping forever. */
const MAX_DEPTH = 6

export interface EmitOptions
{
    readonly recordId?: string | null
    readonly payload?: Record<string, unknown>
}

/**
 * Every change in the system is an event. Emitting one:
 * 1. stores it (the audit trail and the activity feeds read this),
 * 2. runs the listeners of switched-on modules,
 * 3. runs the company's automation rules, whose actions may need approval.
 */
export class EventBus
{
    private depth = 0
    private systemCtx: Ctx | undefined
    readonly log: StudioEvent[] = []

    constructor(private readonly ctx: Ctx) {}

    /**
     * Module listeners and automation rules act for the company, not for the
     * person whose change set them off: an employee finishing the last task
     * may close a phase they cannot edit. The stored event still names the
     * person, so the audit trail shows who caused what.
     */
    private system(): Ctx
    {
        if (this.ctx.actor.kind !== 'user') return this.ctx
        if (!this.systemCtx) {
            const c = { ...this.ctx, actor: SYSTEM } as { -readonly [K in keyof Ctx]: Ctx[K] }
            c.records = new RecordStore(c)
            c.actions = new ActionRunner(c)
            c.events = this
            this.systemCtx = c
        }
        return this.systemCtx
    }

    async emit(name: string, opts: EmitOptions = {}): Promise<StudioEvent>
    {
        const event: StudioEvent = {
            name,
            companyId: this.ctx.companyId,
            recordId: opts.recordId ?? null,
            actor: this.ctx.actor,
            payload: opts.payload ?? {},
        }
        await this.ctx.db.query(
            `insert into events (company_id, name, record_id, actor_id, actor_kind, payload) values ($1, $2, $3, $4, $5, $6::jsonb)`,
            [event.companyId, name, event.recordId, event.actor.id, event.actor.kind, JSON.stringify(event.payload)],
        )
        this.log.push(event)
        if (this.depth >= MAX_DEPTH) return event
        this.depth++
        try {
            for (const handler of this.ctx.registry.handlersFor(name)) await handler(this.system(), event)
            await this.runAutomations(event)
        } finally {
            this.depth--
        }
        return event
    }

    private async runAutomations(event: StudioEvent): Promise<void>
    {
        const rows = await this.ctx.db.query<AutomationRow>(
            `select * from automations where company_id = $1 and enabled and (when_event = $2 or when_event = '*')`,
            [this.ctx.companyId, event.name],
        )
        for (const rule of rows.map(toRule)) {
            if (!ruleMatches(rule, event)) continue
            if (!this.ctx.registry.actions().some((a) => a.name === rule.action)) continue
            await this.system().actions.request(rule.action, fillParams(rule.params, event), { via: `automation:${rule.id}`, automated: true })
        }
    }

    async recent(limit = 50): Promise<{ name: string; record_id: string | null; actor_id: string; payload: unknown; created_at: string }[]>
    {
        return this.ctx.db.query(
            `select name, record_id, actor_id, payload, created_at from events where company_id = $1 order by id desc limit $2`,
            [this.ctx.companyId, limit],
        )
    }
}
