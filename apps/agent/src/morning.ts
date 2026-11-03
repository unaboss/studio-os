import { daysBetween, formatMoney, type ActionOutcome, type Ctx } from '@studio-os/core'
import { amountDue } from '@studio-os/module-money'
import { extractJson, type Inference } from './inference.ts'

/** Actions the agent may ask for unless Settings says otherwise. */
export const DEFAULT_AGENT_ACTIONS = ['invoice.send_reminder', 'invoice.send', 'bank.auto_match']

export interface Proposal
{
    readonly action: string
    readonly params: Record<string, unknown>
    readonly why: string
}

export interface MorningResult
{
    readonly brief: string
    readonly model: string | null
    readonly proposals: readonly (Proposal & { outcome: ActionOutcome | { status: 'refused'; reason: string } })[]
    readonly facts: Facts
}

interface OverdueFact
{
    readonly invoiceId: string
    readonly number: string
    readonly client: string
    readonly amountDue: string
    readonly daysLate: number
    readonly lastReminder: string | null
}

export interface Facts
{
    readonly today: string
    readonly company: string
    readonly tiles: Record<string, { value?: string | undefined; caption?: string | undefined }>
    readonly overdue: OverdueFact[]
    readonly draftInvoices: { invoiceId: string; number: string; amount: string; project: string }[]
    readonly waitingApprovals: string[]
    readonly unmatchedMoneyIn: number
    readonly deadlines: { title: string; due: string; status: string }[]
    readonly followUps: { lead: string; on: string; nextStep: string }[]
    readonly suggestedTime: number
}

const has = (ctx: Ctx, type: string) => ctx.registry.hasRecordType(type)

/** Everything the agent looks at, gathered without the model. */
export async function gatherFacts(ctx: Ctx): Promise<Facts>
{
    const today = ctx.now().toISOString().slice(0, 10)
    const tiles: Facts['tiles'] = {}
    for (const tile of ctx.registry.tiles('manage')) {
        try {
            const data = await tile.load(ctx)
            tiles[tile.title] = { value: data.value, caption: data.caption }
        } catch {
            // A broken tile should not stop the morning run.
        }
    }
    const clients = new Map<string, string>()
    const clientName = async (id: unknown) => {
        if (typeof id !== 'string') return 'Unknown client'
        if (!clients.has(id)) clients.set(id, (await ctx.records.getRaw(id)).title)
        return clients.get(id)!
    }
    const overdue: OverdueFact[] = []
    const draftInvoices: Facts['draftInvoices'] = []
    let unmatchedMoneyIn = 0
    if (has(ctx, 'invoice')) {
        for (const inv of await ctx.records.list('invoice', { status: ['Sent', 'Part paid'] })) {
            const days = inv.data.due ? daysBetween(String(inv.data.due), ctx.now()) : 0
            if (days <= 0) continue
            overdue.push({
                invoiceId: inv.id,
                number: String(inv.data.number),
                client: await clientName(inv.data.client),
                amountDue: formatMoney(amountDue(inv), ctx.config.currency),
                daysLate: days,
                lastReminder: inv.data.lastReminder ? String(inv.data.lastReminder) : null,
            })
        }
        for (const inv of await ctx.records.list('invoice', { status: 'Draft' })) {
            draftInvoices.push({ invoiceId: inv.id, number: String(inv.data.number), amount: formatMoney(Number(inv.data.amount), ctx.config.currency), project: inv.title })
        }
        unmatchedMoneyIn = (await ctx.records.list('bank_line', { status: 'Unmatched' })).filter((l) => Number(l.data.amount) > 0).length
    }
    const deadlines = has(ctx, 'obligation')
        ? (await ctx.records.list('obligation', { status: ['Upcoming', 'Overdue'] }))
            .filter((o) => daysBetween(String(o.data.due), ctx.now()) >= -14)
            .map((o) => ({ title: o.title, due: String(o.data.due), status: o.status }))
        : []
    const followUps = has(ctx, 'lead')
        ? (await ctx.records.list('lead', { status: ['New', 'Talking', 'Proposal sent'] }))
            .filter((l) => l.data.followUp && String(l.data.followUp) <= today)
            .map((l) => ({ lead: l.title, on: String(l.data.followUp), nextStep: String(l.data.nextStep ?? '') }))
        : []
    const suggestedTime = has(ctx, 'time') ? (await ctx.records.list('time', { status: 'Suggested' })).length : 0
    const waitingApprovals = (await ctx.actions.pending()).map((a) => a.summary)
    return {
        today,
        company: ctx.config.theme.name,
        tiles,
        overdue,
        draftInvoices,
        waitingApprovals,
        unmatchedMoneyIn,
        deadlines,
        followUps,
        suggestedTime,
    }
}

/** What the agent would do with no model at all: still useful, never creative. */
export function plainProposals(facts: Facts, pendingInvoiceIds: Set<string>): Proposal[]
{
    const out: Proposal[] = []
    if (facts.unmatchedMoneyIn > 0) out.push({ action: 'bank.auto_match', params: {}, why: `${facts.unmatchedMoneyIn} payments in the bank are not matched to invoices yet.` })
    for (const o of facts.overdue) {
        if (pendingInvoiceIds.has(o.invoiceId)) continue
        if (o.lastReminder && daysBetween(o.lastReminder, new Date(`${facts.today}T12:00:00Z`)) < 7) continue
        if (o.daysLate < 3) continue
        out.push({ action: 'invoice.send_reminder', params: { invoiceId: o.invoiceId }, why: `${o.number} (${o.client}, ${o.amountDue}) is ${o.daysLate} days late.` })
    }
    return out
}

export function plainBrief(f: Facts): string
{
    const lines: string[] = []
    const cash = f.tiles['Cash in the bank']
    if (cash?.value && cash.value !== '—') lines.push(`Cash is ${cash.value} (${cash.caption}).`)
    if (f.overdue.length) {
        const worst = [...f.overdue].sort((a, b) => b.daysLate - a.daysLate)[0]!
        lines.push(`${f.overdue.length} invoice${f.overdue.length === 1 ? ' is' : 's are'} overdue; the oldest is ${worst.number} from ${worst.client}, ${worst.daysLate} days late.`)
    } else lines.push('No invoices are overdue.')
    if (f.draftInvoices.length) lines.push(`${f.draftInvoices.length} draft invoice${f.draftInvoices.length === 1 ? ' is' : 's are'} ready to send.`)
    const soon = f.deadlines.filter((d) => d.status === 'Overdue' || daysBetween(d.due, new Date(`${f.today}T12:00:00Z`)) >= -7)
    if (soon.length) lines.push(`Deadlines: ${soon.map((d) => `${d.title} (${d.status === 'Overdue' ? 'overdue' : `due ${d.due}`})`).join('; ')}.`)
    if (f.followUps.length) lines.push(`Follow up today with ${f.followUps.map((l) => l.lead).join(', ')}.`)
    if (f.suggestedTime) lines.push(f.suggestedTime === 1 ? 'One time entry suggested from GitHub is waiting to be confirmed.' : `${f.suggestedTime} time entries suggested from GitHub are waiting to be confirmed.`)
    return lines.join(' ')
}

const SYSTEM_PROMPT = `You are the back-office agent for a small software studio. Each morning you read the facts below and write:
1. "brief": a short morning note for the owner, at most 6 sentences, plain words, most important first. Use the numbers given; never invent figures.
2. "proposals": actions to queue for the owner's approval. Only use these actions: {{ACTIONS}}.
   For invoice.send_reminder you may include "message": a short, warm, professional reminder in South African English, signed with the company name. Mention the invoice number, amount and how late it is.
   Do not propose a reminder for an invoice reminded in the last 7 days. Do not propose anything already waiting for approval.
Reply with one JSON object only: {"brief": string, "proposals": [{"action": string, "params": object, "why": string}]}`

/**
 * The morning run: refresh the checks, gather facts, ask the model for a
 * brief and proposals, and queue the proposals. Anything that leaves the
 * company waits for a manager; the agent never sends on its own.
 */
export async function runMorning(ctx: Ctx, inference: Inference | null): Promise<MorningResult>
{
    for (const check of ['invoice.check_overdue', 'compliance.check']) {
        if (ctx.registry.actions().some((a) => a.name === check)) await ctx.actions.request(check, {}, { via: 'agent', automated: true })
    }
    const facts = await gatherFacts(ctx)
    const allowed = ((ctx.config.settings?.agent?.actions as string[] | undefined) ?? DEFAULT_AGENT_ACTIONS).filter((a) => ctx.registry.actions().some((x) => x.name === a))
    const pending = await ctx.actions.pending()
    const pendingInvoiceIds = new Set(pending.map((p) => String((typeof p.params === 'string' ? JSON.parse(p.params) : p.params)?.invoiceId ?? '')))

    let brief = plainBrief(facts)
    let proposals: Proposal[] = plainProposals(facts, pendingInvoiceIds)
    let model: string | null = null
    if (inference) {
        try {
            const reply = await inference.chat([
                { role: 'system', content: SYSTEM_PROMPT.replace('{{ACTIONS}}', allowed.join(', ')) },
                { role: 'user', content: JSON.stringify(facts, null, 1) },
            ])
            const parsed = extractJson(reply) as { brief?: unknown; proposals?: unknown }
            if (typeof parsed.brief === 'string' && parsed.brief.trim()) brief = parsed.brief.trim()
            if (Array.isArray(parsed.proposals)) {
                proposals = parsed.proposals
                    .filter((p): p is Proposal => !!p && typeof p.action === 'string' && typeof p.params === 'object' && p.params !== null)
                    .map((p) => ({ action: p.action, params: p.params, why: String(p.why ?? '') }))
            }
            model = inference.model
        } catch (err) {
            brief = `${brief} (The model could not be reached this morning: ${err instanceof Error ? err.message : String(err)}. This note was written without it.)`
        }
    }

    const results: MorningResult['proposals'][number][] = []
    const seen = new Set<string>()
    for (const p of proposals.slice(0, 10)) {
        const key = `${p.action}|${JSON.stringify(p.params.invoiceId ?? p.params)}`
        if (seen.has(key)) continue
        seen.add(key)
        if (!allowed.includes(p.action)) {
            results.push({ ...p, outcome: { status: 'refused', reason: 'The agent is not allowed this action' } })
            continue
        }
        if (typeof p.params.invoiceId === 'string') {
            const known = facts.overdue.some((o) => o.invoiceId === p.params.invoiceId) || facts.draftInvoices.some((d) => d.invoiceId === p.params.invoiceId)
            if (!known || pendingInvoiceIds.has(p.params.invoiceId)) {
                results.push({ ...p, outcome: { status: 'refused', reason: known ? 'Already waiting for approval' : 'Unknown invoice' } })
                continue
            }
        }
        try {
            const outcome = await ctx.actions.request(p.action, p.params, { via: 'agent', automated: true })
            results.push({ ...p, outcome })
        } catch (err) {
            results.push({ ...p, outcome: { status: 'refused', reason: err instanceof Error ? err.message : String(err) } })
        }
    }
    await ctx.events.emit('agent.brief', { payload: { text: brief, model, proposals: results.map((r) => ({ action: r.action, why: r.why, status: r.outcome.status })) } })
    return { brief, model, proposals: results, facts }
}

