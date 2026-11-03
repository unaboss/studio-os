import { describe, expect, it } from 'vitest'
import projects from '@studio-os/module-projects'
import sales from '@studio-os/module-sales'
import { testStudio } from '@studio-os/testing'

describe('sales', () => {
    it('wins a lead into a client and a phased project', async () => {
        const s = await testStudio([projects, sales])
        const m = s.as(s.manager)
        const lead = await m.records.create({ type: 'lead', title: 'Booking site', data: { company: 'Umhlanga Dive', email: 'hi@dive.example', value: 6_500_000, projectType: 'build' } })
        const out = await m.actions.request('lead.win', { leadId: lead.id })
        expect(out.status).toBe('done')
        const [client] = await m.records.list('client')
        expect(client!.title).toBe('Umhlanga Dive')
        const [project] = await m.records.list('project')
        expect(project!.data.value).toBe(6_500_000)
        expect(await m.records.list('phase', { parentId: project!.id })).toHaveLength(3)
        expect((await m.records.get(lead.id)).status).toBe('Won')
    })

    it('keeps leads away from employees', async () => {
        const s = await testStudio([projects, sales])
        await s.as(s.manager).records.create({ type: 'lead', title: 'Secret' })
        expect(await s.as(s.employee).records.list('lead')).toHaveLength(0)
        await expect(s.as(s.employee).records.create({ type: 'lead', title: 'Nope' })).rejects.toThrow()
    })
})
