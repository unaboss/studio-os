// The code CRM end to end: project health, people and the tree, read from real git repos.
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pgliteDb } from '@studio-os/core'
import { createApp } from '../src/app.ts'
import { codeRepos } from '../src/codetree.ts'
import { makeDemoRepos } from '../src/demo-repos.ts'
import { seedDemo } from '../src/seed.ts'
import { migrateAll } from '../src/studio.ts'

const NOW = new Date('2026-11-08T12:00:00Z')
let app: ReturnType<typeof createApp>
let dir: string

beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), 'codecrm-'))
    const local = await makeDemoRepos(join(dir, 'demo'), NOW)
    const db = pgliteDb(new PGlite())
    await migrateAll(db)
    await seedDemo(db, { now: NOW })
    app = createApp({ db, sessionSecret: 'x'.repeat(40), demo: true, inference: null, code: codeRepos({ dir, local }), now: () => NOW })
}, 90_000)
afterAll(() => rm(dir, { recursive: true, force: true }))

async function as(email: string, password: string)
{
    const res = await app.request('/api/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email, password }) })
    const cookie = res.headers.get('set-cookie')!.split(';')[0]!
    return async (path: string, body?: unknown) => {
        const r = await app.request(path, body === undefined ? { headers: { cookie } } : { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) })
        return { status: r.status, body: (await r.json()) as any }
    }
}

describe('code CRM', () => {
    it('gives each project a health dot from its code, busiest first', async () => {
        const get = await as('thabo@demo.studio', 'demo-manager')
        const { body } = await get('/api/code')
        expect(body.enabled).toBe(true)
        const by = Object.fromEntries(body.repos.map((r: any) => [r.repo, r]))
        expect(body.repos[0].repo).toBe('demo-studio/karoo-ordering')
        expect(by['demo-studio/karoo-ordering'].openBranches).toBe(3)
        expect(by['demo-studio/karoo-ordering'].reasons).toContain('1 review is waiting')
        expect(by['demo-studio/tidepool-booking'].health).toBe('attention')
        expect(by['demo-studio/tidepool-booking'].reasons[0]).toMatch(/Checks are failing/)
        expect(by['demo-studio/marula-portal'].health).toBe('good')
        // No money anywhere in the code view.
        expect(JSON.stringify(body)).not.toMatch(/invoice|value|amount/i)
    })

    it("shows each person's branches, commits and reviews across projects", async () => {
        const get = await as('thabo@demo.studio', 'demo-manager')
        const { body } = await get('/api/code/people')
        const lerato = body.people.find((p: any) => p.name === 'Lerato Mokoena')
        expect(lerato.branches.map((b: any) => b.name)).toEqual(['feature/cart-checkout'])
        expect(lerato.reviews.map((r: any) => r.title)).toEqual(['Yoco payments integration'])
        expect(lerato.recent.length).toBeGreaterThan(0)
        const sipho = body.people.find((p: any) => p.name === 'Sipho Dlamini')
        expect(sipho.branches.map((b: any) => b.name).sort()).toEqual(['deposit-payments', 'feature/barista-notifications'])
    })

    it('lets a developer walk the tree and ask the agent, but only for linked repos', async () => {
        const get = await as('lerato@demo.studio', 'demo-employee')
        const graph = await get('/api/code/graph?repo=demo-studio/karoo-ordering')
        expect(graph.status).toBe(200)
        const tip = graph.body.branches.find((b: any) => b.name === 'feature/yoco-payments').sha
        const explained = await get('/api/code/explain?repo=demo-studio/karoo-ordering', { sha: tip })
        expect(explained.status).toBe(200)
        expect(explained.body.summary).toMatch(/Thabo changed 1 file/)
        expect(explained.body.review.join(' ')).toMatch(/payment|webhook/i)
        expect((await get('/api/code/graph?repo=someone/else')).status).toBe(403)
    })
})
