import { coreMigrations, DEFAULT_CONFIG, migrate, Registry, type CompanyConfig, type Db, type ModuleDef } from '@studio-os/core'
import compliance from '@studio-os/module-compliance'
import github from '@studio-os/module-github'
import money from '@studio-os/module-money'
import people from '@studio-os/module-people'
import projects from '@studio-os/module-projects'
import sales from '@studio-os/module-sales'

/** Every module this server can switch on. Each company picks from these in Settings. */
export const INSTALLED: readonly ModuleDef[] = [projects, money, people, sales, compliance, github]

export const apiMigrations = [
    {
        name: '0100_api',
        sql: `
create table bank_parsers (
    id text primary key,
    company_id text not null references companies(id),
    signature text not null,
    code text not null,
    notes text not null default '',
    created_at timestamptz not null default now()
);

create index bank_parsers_signature on bank_parsers (company_id, signature);
`,
    },
]

export async function migrateAll(db: Db): Promise<string[]>
{
    return migrate(db, [...coreMigrations, ...INSTALLED.flatMap((m) => m.migrations ?? []), ...apiMigrations])
}

/** Fills in anything a stored config is missing, so older companies keep working as modules grow. */
export function normaliseConfig(stored: Partial<CompanyConfig> | null | undefined): CompanyConfig
{
    const c = stored ?? {}
    return {
        ...DEFAULT_CONFIG,
        ...c,
        theme: { ...DEFAULT_CONFIG.theme, ...(c.theme ?? {}) },
        layouts: { ...DEFAULT_CONFIG.layouts, ...(c.layouts ?? {}) },
        fields: c.fields ?? {},
        statuses: c.statuses ?? {},
        settings: c.settings ?? {},
    }
}

/**
 * Registries are built from each company's config and cached until the
 * config changes. Building one also validates the config, so a bad save
 * fails before it is stored.
 */
export class Companies
{
    private cache = new Map<string, Registry>()

    constructor(private readonly db: Db) {}

    async registry(companyId: string): Promise<Registry>
    {
        const hit = this.cache.get(companyId)
        if (hit) return hit
        const rows = await this.db.query<{ config: CompanyConfig | string }>('select config from companies where id = $1', [companyId])
        if (!rows[0]) throw new Error(`No company ${companyId}`)
        const raw = typeof rows[0].config === 'string' ? JSON.parse(rows[0].config) : rows[0].config
        const registry = new Registry(INSTALLED, normaliseConfig(raw))
        this.cache.set(companyId, registry)
        return registry
    }

    async save(companyId: string, config: CompanyConfig): Promise<Registry>
    {
        const registry = new Registry(INSTALLED, normaliseConfig(config))
        await this.db.query('update companies set config = $1::jsonb where id = $2', [JSON.stringify(registry.config), companyId])
        this.cache.set(companyId, registry)
        return registry
    }

    async first(): Promise<string | null>
    {
        const rows = await this.db.query<{ id: string }>('select id from companies order by created_at limit 1')
        return rows[0]?.id ?? null
    }
}
