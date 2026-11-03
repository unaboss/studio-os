/**
 * The one database seam. Production uses postgres.js, tests use PGlite;
 * both are wrapped into this shape so nothing else knows which is which.
 */
export interface Db
{
    query<T = Record<string, unknown>>(text: string, params?: unknown[]): Promise<T[]>
    transaction<T>(fn: (tx: Db) => Promise<T>): Promise<T>
}

/** Structural type for a PGlite instance (avoids a hard dependency). */
interface PgliteLike
{
    query<T>(text: string, params?: unknown[]): Promise<{ rows: T[] }>
    exec(text: string): Promise<unknown>
    transaction<T>(fn: (tx: { query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }> }) => Promise<T>): Promise<T>
}

export function pgliteDb(pg: PgliteLike): Db
{
    type Run = (text: string, params: unknown[]) => Promise<{ rows: unknown[] }>
    const fromRun = (run: Run): Db => {
        const db: Db = {
            async query<T>(text: string, params: unknown[] = []) {
                return (await run(text, params)).rows as T[]
            },
            // Nested transactions reuse the outer one.
            transaction: (fn) => fn(db),
        }
        return db
    }
    const root = fromRun((text, params) => pg.query(text, params))
    root.transaction = (fn) => pg.transaction((tx) => fn(fromRun((text, params) => tx.query(text, params))))
    return root
}

/** Structural type for a postgres.js `sql` instance. */
interface PostgresJsLike
{
    unsafe(text: string, params?: unknown[]): Promise<unknown>
    begin<T>(fn: (tx: PostgresJsLike) => Promise<T>): Promise<unknown>
}

export function postgresJsDb(sql: PostgresJsLike): Db
{
    const make = (s: PostgresJsLike): Db => ({
        async query<T>(text: string, params: unknown[] = []) {
            return (await s.unsafe(text, params as never[])) as T[]
        },
        async transaction<T>(fn: (tx: Db) => Promise<T>) {
            return (await s.begin((tx) => fn(make(tx)))) as T
        },
    })
    return make(sql)
}

/** Applies `.sql` migrations in name order, once each. */
export async function migrate(db: Db, migrations: { name: string; sql: string }[]): Promise<string[]>
{
    await db.query(`create table if not exists _migrations (name text primary key, applied_at timestamptz not null default now())`)
    const done = new Set((await db.query<{ name: string }>('select name from _migrations')).map((r) => r.name))
    const applied: string[] = []
    for (const m of [...migrations].sort((a, b) => a.name.localeCompare(b.name))) {
        if (done.has(m.name)) continue
        for (const statement of splitSql(m.sql)) await db.query(statement)
        await db.query('insert into _migrations (name) values ($1)', [m.name])
        applied.push(m.name)
    }
    return applied
}

/** Splits a migration file on semicolons at line ends (no procedural SQL in migrations). */
export function splitSql(sql: string): string[]
{
    return sql
        .split(/;\s*$/m)
        .map((s) => s.replace(/^\s*--.*$/gm, '').trim())
        .filter((s) => s.length > 0)
}
