import type { Db } from './db.ts'

/* ------------------------------------------------------------------ */
/* People and access                                                   */
/* ------------------------------------------------------------------ */

/** Which side of the app a person lands on. Managers can open both. */
export type Role = 'manager' | 'employee'

export interface Actor
{
    /** A user id, or `agent` / `system` for automated work. */
    readonly id: string
    readonly kind: 'user' | 'agent' | 'system'
    readonly role: Role
    readonly name: string
}

/* ------------------------------------------------------------------ */
/* Records: everything is a typed record with custom fields            */
/* ------------------------------------------------------------------ */

export type FieldKind = 'text' | 'longtext' | 'number' | 'money' | 'date' | 'select' | 'boolean' | 'url' | 'user' | 'users' | 'record'

export interface FieldDef
{
    readonly key: string
    readonly label: string
    readonly kind: FieldKind
    readonly required?: boolean
    /** For `select`. */
    readonly options?: readonly string[]
    /** For `record`: which record type it points at. */
    readonly recordType?: string
    /** Hidden from employees (salaries, rates, bank details). */
    readonly sensitive?: boolean
    /** Added in Settings rather than shipped by a module. */
    readonly custom?: boolean
}

/** Who can see records of a type. */
export type Visibility = 'everyone' | 'managers' | 'assigned'

export interface RecordTypeDef
{
    readonly type: string
    readonly label: string
    readonly plural: string
    /** The record type this one usually sits under (task → project). */
    readonly parent?: string
    readonly fields: readonly FieldDef[]
    readonly statuses: readonly string[]
    readonly visibility?: Visibility
    /** For `assigned` visibility: the `user` or `users` field that grants access. */
    readonly assigneeField?: string
    /** Statuses only a manager may set, such as Approved or Reimbursed. */
    readonly managerStatuses?: readonly string[]
    /** false: employees may read these records but never create or change them (payslips). */
    readonly employeeEditable?: boolean
}

export interface StoredRecord
{
    readonly id: string
    readonly companyId: string
    readonly type: string
    readonly status: string
    readonly title: string
    readonly parentId: string | null
    readonly data: Record<string, unknown>
    readonly createdBy: string
    readonly createdAt: string
    readonly updatedAt: string
}

/* ------------------------------------------------------------------ */
/* Events, actions, automations                                        */
/* ------------------------------------------------------------------ */

export interface StudioEvent
{
    readonly name: string
    readonly companyId: string
    readonly recordId?: string | null
    readonly actor: Actor
    readonly payload: Record<string, unknown>
}

export type EventHandler = (ctx: Ctx, event: StudioEvent) => Promise<void>

/** JSON-schema-ish parameter description, shared by the UI, automations and the agent. */
export interface ParamDef
{
    readonly type: 'string' | 'number' | 'boolean'
    readonly description: string
    readonly required?: boolean
}

/**
 * An action is anything the system can do: send an invoice, draft a chase,
 * close a phase. The UI, automation rules and the agent all call actions
 * by name, so a new module's actions are usable everywhere at once.
 */
export interface ActionDef
{
    readonly name: string
    readonly label: string
    readonly description: string
    readonly params: Readonly<Record<string, ParamDef>>
    /** Sends money or messages outside the company: a person must approve it. */
    readonly needsApproval: boolean
    /** Only managers may run (or approve) it. */
    readonly managersOnly?: boolean
    run(ctx: Ctx, params: Record<string, unknown>): Promise<Record<string, unknown>>
}

export type ConditionOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'exists'

export interface Condition
{
    /** Dot path into the event: `payload.daysOverdue`, `payload.record.status`. */
    readonly path: string
    readonly op: ConditionOp
    readonly value?: unknown
}

export interface AutomationRule
{
    readonly id: string
    readonly name: string
    readonly enabled: boolean
    readonly when: string
    readonly conditions: readonly Condition[]
    readonly action: string
    /** Values may reference the event: `{{payload.record.id}}`. */
    readonly params: Readonly<Record<string, unknown>>
}

/* ------------------------------------------------------------------ */
/* Screens                                                             */
/* ------------------------------------------------------------------ */

export type Side = 'manage' | 'employee'

export interface TileData
{
    /** Big number or short headline. */
    readonly value?: string
    readonly caption?: string
    readonly tone?: 'neutral' | 'good' | 'warning' | 'critical'
    readonly items?: readonly { readonly label: string; readonly detail?: string; readonly href?: string; readonly tone?: TileData['tone'] }[]
}

export interface TileDef
{
    readonly id: string
    readonly title: string
    readonly sides: readonly Side[]
    readonly size?: 'sm' | 'md' | 'lg'
    load(ctx: Ctx): Promise<TileData>
}

/* ------------------------------------------------------------------ */
/* Modules                                                             */
/* ------------------------------------------------------------------ */

export interface ModuleDef
{
    readonly id: string
    readonly name: string
    readonly description: string
    readonly dependsOn?: readonly string[]
    /** Always on (the core spine). */
    readonly required?: boolean
    readonly records: readonly RecordTypeDef[]
    readonly emits: readonly string[]
    readonly listens?: Readonly<Record<string, EventHandler>>
    readonly actions?: readonly ActionDef[]
    readonly tiles?: readonly TileDef[]
    /** SQL migrations this module needs beyond the generic record store. */
    readonly migrations?: readonly { readonly name: string; readonly sql: string }[]
}

/* ------------------------------------------------------------------ */
/* Company config: everything that varies lives here                    */
/* ------------------------------------------------------------------ */

export interface PhaseTemplate
{
    readonly name: string
    /** Share of the project value billed when this phase completes (0..1). */
    readonly share: number
}

export interface ProjectType
{
    readonly id: string
    readonly name: string
    readonly billing: 'phased' | 'retainer' | 'hourly'
    readonly phases: readonly PhaseTemplate[]
}

export interface CompanyConfig
{
    readonly currency: string
    readonly modules: readonly string[]
    /** Custom fields per record type, added in Settings. */
    readonly fields: Readonly<Record<string, readonly FieldDef[]>>
    /** Status lists that replace a module's defaults. */
    readonly statuses: Readonly<Record<string, readonly string[]>>
    readonly projectTypes: readonly ProjectType[]
    readonly layouts: Readonly<Record<Side, readonly string[]>>
    readonly theme: { readonly accent: string; readonly name: string }
    /** Days a client has to pay an invoice. */
    readonly paymentTermsDays?: number
    /** Per-module settings, keyed by module id (tax tables, deadlines, sources). */
    readonly settings?: Readonly<Record<string, Readonly<Record<string, unknown>>>>
}

/* ------------------------------------------------------------------ */
/* Context passed to every handler, action and tile                    */
/* ------------------------------------------------------------------ */

export interface Ctx
{
    readonly db: Db
    readonly companyId: string
    readonly actor: Actor
    readonly config: CompanyConfig
    readonly registry: import('./registry.ts').Registry
    readonly records: import('./records.ts').RecordStore
    readonly events: import('./events.ts').EventBus
    readonly actions: import('./actions.ts').ActionRunner
    readonly now: () => Date
    /** Adapters (GitHub, bank, inference, mail) supplied by the app. */
    readonly services: Readonly<Record<string, unknown>>
}
