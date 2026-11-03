import { ActionRunner } from './actions.ts'
import { EventBus } from './events.ts'
import { RecordStore } from './records.ts'
import type { Db } from './db.ts'
import type { Registry } from './registry.ts'
import type { Actor, Ctx } from './types.ts'

export interface ContextInput
{
    readonly db: Db
    readonly companyId: string
    readonly actor: Actor
    readonly registry: Registry
    readonly services?: Readonly<Record<string, unknown>>
    readonly now?: () => Date
}

type Mutable<T> = { -readonly [K in keyof T]: T[K] }

export function createContext(input: ContextInput): Ctx
{
    const ctx = {
        db: input.db,
        companyId: input.companyId,
        actor: input.actor,
        registry: input.registry,
        config: input.registry.config,
        services: input.services ?? {},
        now: input.now ?? (() => new Date()),
    } as Mutable<Ctx>
    ctx.records = new RecordStore(ctx)
    ctx.events = new EventBus(ctx)
    ctx.actions = new ActionRunner(ctx)
    return ctx
}

/** The same context acting as someone else (the agent, the system). */
export function actingAs(ctx: Ctx, actor: Actor): Ctx
{
    return createContext({ db: ctx.db, companyId: ctx.companyId, actor, registry: ctx.registry, services: ctx.services, now: ctx.now })
}

