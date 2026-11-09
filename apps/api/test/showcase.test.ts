// The demo's showcase: real public repos and a real person next to the made-up studio.
import { PGlite } from '@electric-sql/pglite'
import { describe, expect, it } from 'vitest'
import { pgliteDb } from '@studio-os/core'
import { seedDemo, seedShowcase, showcaseFromEnv } from '../src/seed.ts'
import { migrateAll } from '../src/studio.ts'

const NOW = new Date('2026-11-08T12:00:00Z')

describe('demo showcase', () => {
    it('reads the showcase from the environment', () => {
        expect(showcaseFromEnv({})).toBeNull()
        expect(showcaseFromEnv({ DEMO_OWNER: 'Ada Lovelace|ada', DEMO_PEOPLE: 'Charles Babbage|cbabbage, no login', DEMO_REPOS: 'ada/site=Site, not a repo, ada/tool' })).toEqual({
            owner: { name: 'Ada Lovelace', github: 'ada' },
            people: [{ name: 'Charles Babbage', github: 'cbabbage' }],
            client: 'ada',
            repos: [{ repo: 'ada/site', title: 'Site' }, { repo: 'ada/tool', title: 'tool' }],
        })
    })

    it('adds the person and the repos once, next to the made-up studio', async () => {
        const db = pgliteDb(new PGlite())
        await migrateAll(db)
        const show = showcaseFromEnv({ DEMO_OWNER: 'Ada Lovelace|ada', DEMO_PEOPLE: 'Charles Babbage|cbabbage,Ada Lovelace|ada', DEMO_CLIENT: 'Analytical Engines', DEMO_REPOS: 'ada/site=Site,ada/tool=Tool' })!
        await seedShowcase(db, show, { now: NOW }) // no demo studio yet: nothing to add to
        expect(await db.query('select 1 from users where id = $1', ['usr_demo_owner'])).toHaveLength(0)

        await seedDemo(db, { now: NOW })
        await seedShowcase(db, show, { now: NOW })
        await seedShowcase(db, show, { now: NOW })
        const owner = await db.query<{ name: string; github_login: string }>('select name, github_login from users where id = $1', ['usr_demo_owner'])
        expect(owner).toEqual([{ name: 'Ada Lovelace', github_login: 'ada' }])
        const others = await db.query<{ id: string; name: string; role: string }>(`select id, name, role from users where id like 'usr_demo_gh_%'`)
        expect(others).toEqual([{ id: 'usr_demo_gh_cbabbage', name: 'Charles Babbage', role: 'employee' }])
        const projects = await db.query<{ title: string; repo: string }>(
            `select title, data->>'repo' as repo from records where company_id = 'co_demo' and type = 'project' and data->>'repo' like 'ada/%' order by title`,
        )
        expect(projects).toEqual([{ title: 'Site', repo: 'ada/site' }, { title: 'Tool', repo: 'ada/tool' }])
        const clients = await db.query(`select 1 from records where company_id = 'co_demo' and type = 'client' and title = 'Analytical Engines'`)
        expect(clients).toHaveLength(1)
    }, 60_000)
})
