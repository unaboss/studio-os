import { AGENT, createContext, type Db } from '@studio-os/core'
import { runMorning, type Inference } from '@studio-os/agent'
import type { Companies } from './studio.ts'

/** South Africa has no daylight saving: always UTC+2. */
const SAST_OFFSET_HOURS = 2

export function sastHour(d: Date): number
{
    return (d.getUTCHours() + SAST_OFFSET_HOURS) % 24
}

export function sastDate(d: Date): string
{
    return new Date(d.getTime() + SAST_OFFSET_HOURS * 3_600_000).toISOString().slice(0, 10)
}

/**
 * Runs the agent's morning round once a day per company, from the hour set
 * in Settings (06:00 by default). It lives in the API process, which is
 * always on: one of the reasons this runs on a VM rather than as functions.
 */
export function startScheduler(opts: { db: Db; companies: Companies; inference: Inference | null; services: (companyId: string) => Record<string, unknown> }): () => void
{
    let busy = false
    const tick = async () => {
        if (busy) return
        busy = true
        try {
            const now = new Date()
            const companies = await opts.db.query<{ id: string }>('select id from companies')
            for (const { id } of companies) {
                const registry = await opts.companies.registry(id)
                const hour = Number(registry.config.settings?.agent?.hour ?? 6)
                if (sastHour(now) < hour) continue
                const ran = await opts.db.query(
                    `select 1 from events where company_id = $1 and name = 'agent.brief' and actor_id = 'agent'
                       and (created_at + interval '2 hours')::date = $2::date limit 1`,
                    [id, sastDate(now)],
                )
                if (ran.length > 0) continue
                const ctx = createContext({ db: opts.db, companyId: id, actor: AGENT, registry, services: opts.services(id) })
                await runMorning(ctx, opts.inference)
                console.log(`agent: morning run done for ${id}`)
            }
        } catch (err) {
            console.error('agent: morning run failed', err)
        } finally {
            busy = false
        }
    }
    const timer = setInterval(tick, 60_000)
    void tick()
    return () => clearInterval(timer)
}
