import { PGlite } from '@electric-sql/pglite'
import
{
    coreMigrations,
    createContext,
    DEFAULT_CONFIG,
    migrate,
    pgliteDb,
    Registry,
    SYSTEM,
    type Actor,
    type CompanyConfig,
    type Ctx,
    type Db,
    type ModuleDef,
} from '@studio-os/core'

export interface TestStudio
{
    readonly db: Db
    readonly companyId: string
    readonly registry: Registry
    readonly manager: Actor
    readonly employee: Actor
    /** A context for one actor; the clock and services are shared. */
    as(actor: Actor): Ctx
    readonly system: Ctx
    clock: Date
    readonly services: Record<string, unknown>
}

/**
 * An in-memory Postgres with one company, a manager (Thabo) and an
 * employee (Lerato), for module tests.
 */
export async function testStudio(modules: readonly ModuleDef[], config: Partial<CompanyConfig> = {}): Promise<TestStudio>
{
    const db = pgliteDb(new PGlite())
    const migrations = [...coreMigrations, ...modules.flatMap((m) => m.migrations ?? [])]
    await migrate(db, migrations)
    const companyId = 'co_test'
    const full: CompanyConfig = { ...DEFAULT_CONFIG, ...config, modules: config.modules ?? modules.map((m) => m.id) }
    await db.query('insert into companies (id, name, config) values ($1, $2, $3::jsonb)', [companyId, 'Test Studio', JSON.stringify(full)])
    const manager: Actor = { id: 'usr_thabo', kind: 'user', role: 'manager', name: 'Thabo' }
    const employee: Actor = { id: 'usr_lerato', kind: 'user', role: 'employee', name: 'Lerato' }
    for (const [a, login] of [[manager, 'thabo-dev'], [employee, 'lerato-codes']] as const) {
        await db.query(
            `insert into users (id, company_id, email, name, role, github_login) values ($1, $2, $3, $4, $5, $6)`,
            [a.id, companyId, `${a.name.toLowerCase()}@example.com`, a.name, a.role, login],
        )
    }
    const registry = new Registry(modules, full)
    const studio = {
        db,
        companyId,
        registry,
        manager,
        employee,
        clock: new Date('2026-11-03T08:00:00Z'),
        services: {} as Record<string, unknown>,
        as(actor: Actor): Ctx {
            return createContext({ db, companyId, actor, registry, services: studio.services, now: () => studio.clock })
        },
        get system(): Ctx {
            return studio.as(SYSTEM)
        },
    }
    return studio
}

/** The result of an action that must have run straight away. */
export function done(outcome: import('@studio-os/core').ActionOutcome): Record<string, any>
{
    if (outcome.status !== 'done') throw new Error(`expected the action to run, but it is waiting for approval: ${outcome.summary}`)
    return outcome.result
}
