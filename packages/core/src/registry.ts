import type { ActionDef, CompanyConfig, EventHandler, FieldDef, ModuleDef, RecordTypeDef, Side, TileDef } from './types.ts'

export function defineModule(def: ModuleDef): ModuleDef
{
    return def
}

export class ConfigError extends Error {}

/**
 * The registry is the malleable part: it merges the installed modules with a
 * company's config (switched-on modules, custom fields, status lists, layouts)
 * into the one picture every other part of the system reads.
 */
export class Registry
{
    readonly modules: readonly ModuleDef[]
    private readonly types = new Map<string, RecordTypeDef & { module: string }>()
    private readonly actionMap = new Map<string, ActionDef & { module: string }>()
    private readonly tileMap = new Map<string, TileDef & { module: string }>()
    private readonly listeners = new Map<string, EventHandler[]>()

    constructor(installed: readonly ModuleDef[], readonly config: CompanyConfig)
    {
        this.modules = resolveActive(installed, config.modules)
        for (const mod of this.modules) {
            for (const rt of mod.records) {
                if (this.types.has(rt.type)) throw new ConfigError(`record type "${rt.type}" is defined twice`)
                this.types.set(rt.type, { ...applyConfig(rt, config), module: mod.id })
            }
            for (const action of mod.actions ?? []) {
                if (this.actionMap.has(action.name)) throw new ConfigError(`action "${action.name}" is defined twice`)
                this.actionMap.set(action.name, { ...action, module: mod.id })
            }
            for (const tile of mod.tiles ?? []) this.tileMap.set(tile.id, { ...tile, module: mod.id })
            for (const [event, handler] of Object.entries(mod.listens ?? {})) {
                const list = this.listeners.get(event) ?? []
                list.push(handler)
                this.listeners.set(event, list)
            }
        }
    }

    recordType(type: string): RecordTypeDef
    {
        const rt = this.types.get(type)
        if (!rt) throw new ConfigError(`unknown or switched-off record type "${type}"`)
        return rt
    }

    hasRecordType(type: string): boolean
    {
        return this.types.has(type)
    }

    recordTypes(): RecordTypeDef[]
    {
        return [...this.types.values()]
    }

    action(name: string): ActionDef
    {
        const a = this.actionMap.get(name)
        if (!a) throw new ConfigError(`unknown or switched-off action "${name}"`)
        return a
    }

    actions(): ActionDef[]
    {
        return [...this.actionMap.values()]
    }

    handlersFor(event: string): EventHandler[]
    {
        return [...(this.listeners.get(event) ?? []), ...(this.listeners.get('*') ?? [])]
    }

    /** Tiles for a side, in the company's saved order, then any new ones. */
    tiles(side: Side): TileDef[]
    {
        const available = [...this.tileMap.values()].filter((t) => t.sides.includes(side))
        const order = this.config.layouts[side] ?? []
        const ranked = order.map((id) => available.find((t) => t.id === id)).filter((t): t is TileDef & { module: string } => !!t)
        return [...ranked, ...available.filter((t) => !order.includes(t.id))]
    }
}

/** Switched-on modules plus required ones, with dependencies pulled in. */
function resolveActive(installed: readonly ModuleDef[], wanted: readonly string[]): ModuleDef[]
{
    const byId = new Map(installed.map((m) => [m.id, m]))
    const active = new Set<string>()
    const add = (id: string, chain: string[]) => {
        if (active.has(id)) return
        const mod = byId.get(id)
        if (!mod) throw new ConfigError(`module "${id}" is not installed${chain.length ? ` (needed by ${chain.join(' → ')})` : ''}`)
        for (const dep of mod.dependsOn ?? []) add(dep, [...chain, id])
        active.add(id)
    }
    for (const m of installed) if (m.required) add(m.id, [])
    for (const id of wanted) add(id, [])
    return installed.filter((m) => active.has(m.id))
}

function applyConfig(rt: RecordTypeDef, config: CompanyConfig): RecordTypeDef
{
    const custom = (config.fields[rt.type] ?? []).map((f): FieldDef => ({ ...f, custom: true }))
    const clash = custom.find((f) => rt.fields.some((base) => base.key === f.key))
    if (clash) throw new ConfigError(`custom field "${clash.key}" clashes with a built-in field on ${rt.type}`)
    const statuses = config.statuses[rt.type]
    return {
        ...rt,
        fields: [...rt.fields, ...custom],
        statuses: statuses && statuses.length > 0 ? statuses : rt.statuses,
    }
}
