import { defineModule, formatMoney, type Ctx, type TileData } from '@studio-os/core'
import { startProject } from '@studio-os/module-projects'

const OPEN = ['New', 'Talking', 'Proposal sent']

/** Rough chance of winning at each stage, for the weighted pipeline. */
const CHANCE: Record<string, number> = { New: 0.1, Talking: 0.3, 'Proposal sent': 0.6 }

/**
 * Sales: leads and the pipeline. Winning a lead creates the client and the
 * project in one step, so nothing is typed twice.
 */
export default defineModule({
    id: 'sales',
    name: 'Sales',
    description: 'Leads, follow-ups and the pipeline.',
    dependsOn: ['projects'],
    records: [
        {
            type: 'lead',
            label: 'Lead',
            plural: 'Leads',
            visibility: 'managers',
            statuses: ['New', 'Talking', 'Proposal sent', 'Won', 'Lost'],
            fields: [
                { key: 'company', label: 'Company', kind: 'text' },
                { key: 'contact', label: 'Contact person', kind: 'text' },
                { key: 'email', label: 'Email', kind: 'text' },
                { key: 'phone', label: 'Phone', kind: 'text' },
                { key: 'value', label: 'Likely value', kind: 'money' },
                { key: 'projectType', label: 'Project type', kind: 'text' },
                { key: 'source', label: 'Source', kind: 'select', options: ['Referral', 'Website', 'Tender', 'LinkedIn', 'Returning client', 'Other'] },
                { key: 'nextStep', label: 'Next step', kind: 'text' },
                { key: 'followUp', label: 'Follow up on', kind: 'date' },
                { key: 'notes', label: 'Notes', kind: 'longtext' },
            ],
        },
    ],
    emits: ['lead.created', 'lead.won', 'lead.lost', 'lead.status_changed'],
    actions: [
        {
            name: 'lead.win',
            label: 'Win a lead',
            description: 'Marks a lead won and creates its client and project with phases.',
            managersOnly: true,
            needsApproval: false,
            params: {
                leadId: { type: 'string', description: 'Lead record id', required: true },
                projectType: { type: 'string', description: 'Project type id; defaults to the one on the lead' },
                repo: { type: 'string', description: 'GitHub repo, owner/name' },
            },
            async run(ctx, p) {
                const lead = await ctx.records.get(String(p.leadId))
                const name = String(lead.data.company || lead.title)
                const existing = (await ctx.records.list('client')).find((c) => c.title.toLowerCase() === name.toLowerCase())
                const client = existing ?? (await ctx.records.create({
                    type: 'client',
                    title: name,
                    status: 'Active',
                    data: {
                        ...(lead.data.contact ? { contact: lead.data.contact } : {}),
                        ...(lead.data.email ? { email: lead.data.email } : {}),
                        ...(lead.data.phone ? { phone: lead.data.phone } : {}),
                    },
                }))
                const projectType = String(p.projectType ?? lead.data.projectType ?? ctx.config.projectTypes[0]?.id ?? '')
                const project = await startProject(ctx, {
                    clientId: client.id,
                    title: lead.title,
                    projectType,
                    ...(typeof lead.data.value === 'number' ? { valueCents: lead.data.value } : {}),
                    ...(p.repo ? { repo: p.repo } : {}),
                })
                await ctx.records.setStatus(lead.id, 'Won')
                return { clientId: client.id, ...project }
            },
        },
    ],
    tiles: [
        {
            id: 'sales.pipeline',
            title: 'Pipeline',
            sides: ['manage'],
            size: 'md',
            async load(ctx: Ctx): Promise<TileData> {
                const leads = await ctx.records.list('lead', { status: OPEN })
                const today = ctx.now().toISOString().slice(0, 10)
                const weighted = leads.reduce((s, l) => s + Number(l.data.value ?? 0) * (CHANCE[l.status] ?? 0), 0)
                const due = leads.filter((l) => l.data.followUp && String(l.data.followUp) <= today)
                return {
                    value: formatMoney(Math.round(weighted), ctx.config.currency),
                    caption: `weighted, across ${leads.length} open lead${leads.length === 1 ? '' : 's'}`,
                    tone: due.length ? 'warning' : 'neutral',
                    items: leads
                        .sort((a, b) => String(a.data.followUp ?? '9').localeCompare(String(b.data.followUp ?? '9')))
                        .slice(0, 6)
                        .map((l) => ({
                            label: l.title,
                            detail: `${l.status}${l.data.followUp ? ` · follow up ${l.data.followUp}` : ''}${l.data.nextStep ? ` · ${l.data.nextStep}` : ''}`,
                            href: `/records/${l.id}`,
                            tone: (l.data.followUp && String(l.data.followUp) <= today ? 'warning' : 'neutral') as TileData['tone'],
                        })),
                }
            },
        },
    ],
})
