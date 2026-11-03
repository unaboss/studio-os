import { defineModule, ValidationError, type Ctx, type StoredRecord, type TileData } from '@studio-os/core'

const OPEN_TASK = ['To do', 'In progress', 'In review']

/**
 * The spine: client → project → phase → task. Every other module points at
 * these records, so it is always switched on.
 */
export default defineModule({
    id: 'projects',
    name: 'Projects',
    description: 'Clients, projects, phases and tasks.',
    required: true,
    records: [
        {
            type: 'client',
            label: 'Client',
            plural: 'Clients',
            statuses: ['Active', 'Prospect', 'Archived'],
            fields: [
                { key: 'contact', label: 'Contact person', kind: 'text' },
                { key: 'email', label: 'Email', kind: 'text' },
                { key: 'phone', label: 'Phone', kind: 'text' },
            ],
        },
        {
            type: 'project',
            label: 'Project',
            plural: 'Projects',
            parent: 'client',
            visibility: 'assigned',
            assigneeField: 'members',
            statuses: ['Planned', 'Active', 'On hold', 'Done', 'Cancelled'],
            fields: [
                { key: 'client', label: 'Client', kind: 'record', recordType: 'client', required: true },
                { key: 'projectType', label: 'Project type', kind: 'text', required: true },
                { key: 'value', label: 'Project value', kind: 'money', sensitive: true },
                { key: 'start', label: 'Start', kind: 'date' },
                { key: 'due', label: 'Due', kind: 'date' },
                { key: 'lead', label: 'Lead', kind: 'user' },
                { key: 'members', label: 'Team', kind: 'users' },
                { key: 'repo', label: 'GitHub repo', kind: 'text' },
            ],
        },
        {
            type: 'phase',
            label: 'Phase',
            plural: 'Phases',
            parent: 'project',
            statuses: ['Not started', 'In progress', 'Done'],
            fields: [
                { key: 'order', label: 'Order', kind: 'number', required: true },
                { key: 'share', label: 'Share of value', kind: 'number', sensitive: true },
                { key: 'due', label: 'Due', kind: 'date' },
                { key: 'milestone', label: 'GitHub milestone', kind: 'number' },
            ],
        },
        {
            type: 'task',
            label: 'Task',
            plural: 'Tasks',
            parent: 'project',
            statuses: ['To do', 'In progress', 'In review', 'Done'],
            fields: [
                { key: 'phase', label: 'Phase', kind: 'record', recordType: 'phase' },
                { key: 'assignee', label: 'Assignee', kind: 'user' },
                { key: 'estimate', label: 'Estimate (hours)', kind: 'number' },
                { key: 'due', label: 'Due', kind: 'date' },
                { key: 'issue', label: 'GitHub issue', kind: 'number' },
                { key: 'url', label: 'Link', kind: 'url' },
                { key: 'notes', label: 'Notes', kind: 'longtext' },
            ],
        },
    ],
    emits: ['project.created', 'phase.done', 'task.done', 'task.in_review', 'project.slipping'],
    listens: {
        // When every task in a phase is done, the phase is done.
        'task.done': async (ctx, event) => {
            const task = event.payload.record as StoredRecord
            const phaseId = task.data.phase as string | undefined
            if (!phaseId) return
            const siblings = await ctx.records.list('task', { parentId: task.parentId ?? undefined, where: { phase: phaseId } })
            if (siblings.length > 0 && siblings.every((t) => t.status === 'Done')) {
                const phase = await ctx.records.getRaw(phaseId)
                if (phase.status !== 'Done') await ctx.records.setStatus(phaseId, 'Done')
            }
        },
    },
    actions: [
        {
            name: 'project.start',
            label: 'Start a project',
            description: 'Creates a project from a project type, with its phases and payment split.',
            managersOnly: true,
            needsApproval: false,
            params: {
                clientId: { type: 'string', description: 'Client record id', required: true },
                title: { type: 'string', description: 'Project name', required: true },
                projectType: { type: 'string', description: 'Project type id from Settings', required: true },
                valueCents: { type: 'number', description: 'Project value in cents' },
                repo: { type: 'string', description: 'GitHub repo, owner/name' },
                due: { type: 'string', description: 'Due date, YYYY-MM-DD' },
            },
            async run(ctx, p) {
                return startProject(ctx, p)
            },
        },
        {
            name: 'phase.complete',
            label: 'Complete a phase',
            description: 'Marks a project phase done, which can trigger its invoice.',
            needsApproval: false,
            managersOnly: true,
            params: { phaseId: { type: 'string', description: 'Phase record id', required: true } },
            async run(ctx, p) {
                const phase = await ctx.records.setStatus(String(p.phaseId), 'Done')
                return { phaseId: phase.id, status: phase.status }
            },
        },
        {
            name: 'task.move',
            label: 'Move a task',
            description: 'Changes a task status: To do, In progress, In review or Done.',
            needsApproval: false,
            params: {
                taskId: { type: 'string', description: 'Task record id', required: true },
                status: { type: 'string', description: 'New status', required: true },
            },
            async run(ctx, p) {
                const task = await ctx.records.setStatus(String(p.taskId), String(p.status))
                return { taskId: task.id, status: task.status }
            },
        },
    ],
    tiles: [
        {
            id: 'projects.health',
            title: 'Projects',
            sides: ['manage'],
            size: 'lg',
            load: projectHealth,
        },
        {
            id: 'projects.my_tasks',
            title: 'My tasks',
            sides: ['employee', 'manage'],
            size: 'md',
            async load(ctx): Promise<TileData> {
                const tasks = await ctx.records.list('task', { status: OPEN_TASK, where: { assignee: ctx.actor.id } })
                const today = ctx.now().toISOString().slice(0, 10)
                return {
                    value: String(tasks.length),
                    caption: tasks.length === 1 ? 'open task' : 'open tasks',
                    items: tasks.slice(0, 8).map((t) => ({
                        label: t.title,
                        detail: `${t.status}${t.data.due ? ` · due ${t.data.due}` : ''}`,
                        href: `/records/${t.id}`,
                        tone: t.data.due && String(t.data.due) < today ? 'warning' : 'neutral',
                    })),
                }
            },
        },
    ],
})

export async function startProject(ctx: Ctx, p: Record<string, unknown>): Promise<Record<string, unknown>>
{
    const type = ctx.config.projectTypes.find((t) => t.id === p.projectType)
    if (!type) throw new ValidationError([`Unknown project type "${String(p.projectType)}". Add it in Settings first.`])
    const client = await ctx.records.get(String(p.clientId))
    const project = await ctx.records.create({
        type: 'project',
        title: String(p.title),
        status: 'Active',
        parentId: client.id,
        data: {
            client: client.id,
            projectType: type.id,
            ...(typeof p.valueCents === 'number' ? { value: p.valueCents } : {}),
            ...(p.repo ? { repo: String(p.repo) } : {}),
            ...(p.due ? { due: String(p.due) } : {}),
            start: ctx.now().toISOString().slice(0, 10),
            members: ctx.actor.kind === 'user' ? [ctx.actor.id] : [],
        },
    })
    const phases: string[] = []
    for (const [i, ph] of type.phases.entries()) {
        const phase = await ctx.records.create({
            type: 'phase',
            title: ph.name,
            status: i === 0 ? 'In progress' : 'Not started',
            parentId: project.id,
            data: { order: i + 1, share: ph.share },
        })
        phases.push(phase.id)
    }
    return { projectId: project.id, phaseIds: phases }
}

async function projectHealth(ctx: Ctx): Promise<TileData>
{
    const projects = await ctx.records.list('project', { status: ['Active', 'On hold'] })
    const today = ctx.now().toISOString().slice(0, 10)
    const items = []
    let late = 0
    for (const p of projects.slice(0, 10)) {
        const [phases, tasks] = await Promise.all([ctx.records.list('phase', { parentId: p.id }), ctx.records.list('task', { parentId: p.id })])
        const current = phases.sort((a, b) => Number(a.data.order) - Number(b.data.order)).find((ph) => ph.status !== 'Done')
        const done = tasks.filter((t) => t.status === 'Done').length
        const pct = tasks.length ? Math.round((done / tasks.length) * 100) : 0
        const isLate = !!p.data.due && String(p.data.due) < today
        if (isLate) late++
        items.push({
            label: p.title,
            detail: `${current ? current.title : 'All phases done'} · ${pct}% of tasks done${isLate ? ' · past due' : ''}`,
            href: `/records/${p.id}`,
            tone: (isLate ? 'critical' : p.status === 'On hold' ? 'warning' : 'neutral') as TileData['tone'],
        })
    }
    return {
        value: String(projects.length),
        caption: late ? `active, ${late} past due` : 'active projects',
        tone: late ? 'warning' : 'good',
        items,
    }
}
