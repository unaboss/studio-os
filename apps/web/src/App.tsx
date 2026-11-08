import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { api, useApi, type Me, type Schema, type User } from './api.ts'
import { Icon } from './icons.tsx'
import { StudioContext, useStudio as useStudioSafe, type Studio } from './ui.tsx'
import { Login } from './pages/Login.tsx'
import { Today } from './pages/Today.tsx'
import { Projects } from './pages/Projects.tsx'
import { RecordPage } from './pages/Record.tsx'
import { Money } from './pages/Money.tsx'
import { People } from './pages/People.tsx'
import { Sales } from './pages/Sales.tsx'
import { Compliance } from './pages/Compliance.tsx'
import { Automations } from './pages/Automations.tsx'
import { Settings } from './pages/Settings.tsx'
import { Activity } from './pages/Activity.tsx'
import { MyDay, MyTasks, MyTime, MyClaims, MyLeave } from './pages/Employee.tsx'
import { CodeTree } from './pages/CodeTree.tsx'

export function App()
{
    const [me, setMe] = useState<Me | null | 'out'>(null)
    const [schema, setSchema] = useState<Schema | null>(null)
    const [users, setUsers] = useState<User[]>([])
    const [toastMsg, setToast] = useState<{ text: string; error: boolean } | null>(null)

    const load = useCallback(async () => {
        try {
            const m = await api<Me>('/api/me')
            const [s, u] = await Promise.all([api<Schema>('/api/schema'), api<{ users: User[] }>('/api/users')])
            setSchema(s)
            setUsers(u.users)
            setMe(m)
        } catch {
            setMe('out')
        }
    }, [])

    useEffect(() => {
        void load()
        const out = () => setMe('out')
        window.addEventListener('studio:signed-out', out)
        return () => window.removeEventListener('studio:signed-out', out)
    }, [load])

    useEffect(() => {
        if (me && me !== 'out') {
            document.documentElement.style.setProperty('--accent', me.theme.accent)
            document.title = `${me.theme.name || me.company} · Studio OS`
        }
    }, [me])

    useEffect(() => {
        if (!toastMsg) return
        const t = setTimeout(() => setToast(null), 4200)
        return () => clearTimeout(t)
    }, [toastMsg])

    const studio = useMemo<Studio | null>(() => {
        if (!me || me === 'out' || !schema) return null
        const byType = new Map(schema.recordTypes.map((t) => [t.type, t]))
        const names = new Map(users.map((u) => [u.id, u.name]))
        return {
            me,
            schema,
            users,
            type: (t) => byType.get(t),
            userName: (id) => (typeof id === 'string' ? names.get(id) ?? (id === 'agent' ? 'Back-office agent' : id === 'system' ? 'Studio OS' : id === 'github' ? 'GitHub' : 'Someone') : '—'),
            toast: (text, error = false) => setToast({ text, error }),
            refresh: () => void load(),
        }
    }, [me, schema, users, load])

    if (me === null) return null
    if (me === 'out' || !studio) return <Login onSignedIn={load} />

    return (
        <StudioContext.Provider value={studio}>
            <Routes>
                <Route path="/" element={<Navigate to={studio.me.role === 'manager' ? '/manage' : '/me'} replace />} />
                <Route path="/me/*" element={<EmployeeShell />} />
                <Route path="/*" element={studio.me.role === 'manager' ? <ManageShell /> : <EmployeeOnly />} />
            </Routes>
            {toastMsg ? <div className={`toast ${toastMsg.error ? 'error' : ''}`} role="status">{toastMsg.text}</div> : null}
        </StudioContext.Provider>
    )
}

/** Employees reach records they can see (a task, a payslip) inside their own shell. */
function EmployeeOnly()
{
    const loc = useLocation()
    if (loc.pathname.startsWith('/records/')) return <EmployeeShell recordView />
    return <Navigate to="/me" replace />
}

async function signOut()
{
    await api('/api/logout', { body: {} }).catch(() => {})
    window.location.href = '/'
}

function ManageShell()
{
    const { me, schema } = useStudioSafe()
    const [open, setOpen] = useState(false)
    const loc = useLocation()
    useEffect(() => setOpen(false), [loc.pathname])
    const approvals = useApi<{ approvals: unknown[] }>('/api/approvals')
    const on = (id: string) => schema.modules.some((m) => m.id === id)
    const link = (to: string, label: string, icon: () => ReactNode, count?: number) => (
        <NavLink to={to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} end={to === '/manage'}>
            {icon()} {label}
            {count ? <span className="nav-count">{count}</span> : null}
        </NavLink>
    )
    return (
        <div className="shell">
            <div className="topbar">
                <button className="btn ghost sm" onClick={() => setOpen(true)} aria-label="Menu"><Icon.menu /></button>
                <strong>{me.theme.name || me.company}</strong>
                <NavLink to="/me" className="btn ghost sm">My day</NavLink>
            </div>
            <aside className={`sidebar ${open ? 'open' : ''}`}>
                <div className="brand">
                    <div className="brand-mark">{(me.theme.name || me.company).slice(0, 1)}</div>
                    <div>{me.theme.name || me.company}<small>Studio OS</small></div>
                </div>
                {link('/manage', 'Today', Icon.today, approvals.data?.approvals.length)}
                {link('/projects', 'Projects', Icon.projects)}
                {link('/code', 'Code tree', Icon.tree)}
                {on('money') ? link('/money', 'Money', Icon.money) : null}
                {on('people') ? link('/people', 'People', Icon.people) : null}
                {on('sales') ? link('/sales', 'Sales', Icon.sales) : null}
                {on('compliance') ? link('/compliance', 'Compliance', Icon.compliance) : null}
                <div className="nav-section">Make it yours</div>
                {link('/automations', 'Automations', Icon.automations)}
                {link('/activity', 'Activity', Icon.activity)}
                {link('/settings', 'Settings', Icon.settings)}
                <div className="sidebar-foot">
                    <NavLink to="/me" className="nav-link"><Icon.swap /> My day</NavLink>
                    <button className="nav-link" style={{ border: 0, background: 'none', cursor: 'pointer', textAlign: 'left' }} onClick={signOut}><Icon.out /> Sign out</button>
                </div>
            </aside>
            {open ? <div className="overlay" style={{ zIndex: 35 }} onClick={() => setOpen(false)} /> : null}
            <main className="main">
                <Routes>
                    <Route path="/manage" element={<Today />} />
                    <Route path="/projects" element={<Projects />} />
                    <Route path="/code" element={<CodeTree />} />
                    <Route path="/records/:id" element={<RecordPage />} />
                    <Route path="/money/*" element={<Money />} />
                    <Route path="/people/*" element={<People />} />
                    <Route path="/sales" element={<Sales />} />
                    <Route path="/compliance" element={<Compliance />} />
                    <Route path="/automations" element={<Automations />} />
                    <Route path="/activity" element={<Activity />} />
                    <Route path="/settings/*" element={<Settings />} />
                    <Route path="*" element={<Navigate to="/manage" replace />} />
                </Routes>
            </main>
        </div>
    )
}

function EmployeeShell({ recordView = false }: { recordView?: boolean })
{
    const { me } = useStudioSafe()
    const tab = (to: string, label: string, icon: () => ReactNode) => (
        <NavLink to={to} end={to === '/me'} className={({ isActive }) => `tab ${isActive ? 'active' : ''}`}>{icon()}{label}</NavLink>
    )
    return (
        <>
            <div className="phone-shell">
                <div className="spread" style={{ marginBottom: 18 }}>
                    <div className="row">
                        <div className="brand-mark">{(me.theme.name || me.company).slice(0, 1)}</div>
                        <strong>{me.theme.name || me.company}</strong>
                    </div>
                    <div className="row">
                        {me.role === 'manager' ? <NavLink to="/manage" className="btn sm"><Icon.swap /> Manage</NavLink> : null}
                        <button className="btn ghost sm" onClick={signOut} aria-label="Sign out"><Icon.out /></button>
                    </div>
                </div>
                {recordView ? <RecordPage /> : (
                    <Routes>
                        <Route index element={<MyDay />} />
                        <Route path="tasks" element={<MyTasks />} />
                        <Route path="time" element={<MyTime />} />
                        <Route path="claims" element={<MyClaims />} />
                        <Route path="leave" element={<MyLeave />} />
                        <Route path="*" element={<Navigate to="/me" replace />} />
                    </Routes>
                )}
            </div>
            <nav className="tabbar" aria-label="Employee">
                {tab('/me', 'My day', Icon.today)}
                {tab('/me/tasks', 'Tasks', Icon.tasks)}
                {tab('/me/time', 'Time', Icon.time)}
                {tab('/me/claims', 'Claims', Icon.receipt)}
                {tab('/me/leave', 'Leave', Icon.leave)}
            </nav>
        </>
    )
}

