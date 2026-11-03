/** The core tables. Modules add their own through `ModuleDef.migrations`. */
export const coreMigrations = [
    {
        name: '0001_core',
        sql: `
create table companies (
    id text primary key,
    name text not null,
    config jsonb not null,
    created_at timestamptz not null default now()
);

create table users (
    id text primary key,
    company_id text not null references companies(id),
    email text not null unique,
    name text not null,
    role text not null check (role in ('manager', 'employee')),
    password_hash text,
    github_login text,
    active boolean not null default true,
    created_at timestamptz not null default now()
);

create table records (
    id text primary key,
    company_id text not null references companies(id),
    type text not null,
    status text not null,
    title text not null,
    parent_id text references records(id),
    data jsonb not null default '{}'::jsonb,
    created_by text not null,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);

create index records_company_type on records (company_id, type);

create index records_parent on records (parent_id);

create table events (
    id bigserial primary key,
    company_id text not null references companies(id),
    name text not null,
    record_id text,
    actor_id text not null,
    actor_kind text not null,
    payload jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create index events_company_created on events (company_id, created_at desc);

create table automations (
    id text primary key,
    company_id text not null references companies(id),
    name text not null,
    enabled boolean not null default true,
    when_event text not null,
    conditions jsonb not null default '[]'::jsonb,
    action text not null,
    params jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now()
);

create table approvals (
    id text primary key,
    company_id text not null references companies(id),
    action text not null,
    params jsonb not null,
    summary text not null,
    requested_by text not null,
    requested_via text,
    status text not null default 'pending' check (status in ('pending', 'approved', 'rejected', 'failed')),
    decided_by text,
    decided_at timestamptz,
    result jsonb,
    created_at timestamptz not null default now()
);

create index approvals_company_status on approvals (company_id, status);
`,
    },
] as const
