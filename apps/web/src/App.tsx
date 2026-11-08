import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Navigate, NavLink, Route, Routes, useLocation } from 'react-router-dom'
import { api, type Me, type Schema, type User } from './api.ts'
import { Icon } from './icons.tsx'
import { StudioContext, useStudio as useStudioSafe, type Studio } from './ui.tsx'
import { Login } from './pages/Login.tsx'
import { Projects } from './pages/Projects.tsx'
import { RecordPage } from './pages/Record.tsx'
import { Team } from './pages/Team.tsx'
import { Settings } from './pages/Settings.tsx'
import { CodeTree } from './pages/CodeTree.tsx'
import { Profile } from './pages/Profile.tsx'
import { Avatar } from './avatar.tsx'

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
                <Route path="/*" element={<Shell />} />
            </Routes>
            {toastMsg ? <div className={`toast ${toastMsg.error ? 'error' : ''}`} role="status">{toastMsg.text}</div> : null}
        </StudioContext.Provider>
    )
}

async function signOut()
{
    await api('/api/logout', { body: {} }).catch(() => {})
    window.location.href = '/'
}

/** One shell for everyone: the tree, the projects, the people. Managers also get Settings. */
function Shell()
{
    const { me } = useStudioSafe()
    const [open, setOpen] = useState(false)
    const loc = useLocation()
    useEffect(() => setOpen(false), [loc.pathname])
    const isManager = me.role === 'manager'
    const link = (to: string, label: string, icon: () => ReactNode) => (
        <NavLink to={to} className={({ isActive }) => `nav-link ${isActive ? 'active' : ''}`} title={label} aria-label={label}>
            {icon()} <span className="nav-text">{label}</span>
        </NavLink>
    )
    const name = me.theme.name || me.company
    const full = loc.pathname.startsWith('/code')
    return (
        <div className={`shell ${full ? 'full' : ''}`}>
            <div className="topbar">
                <button className="btn ghost sm" onClick={() => setOpen(true)} aria-label="Menu"><Icon.menu /></button>
                <strong>{name}</strong>
                <span />
            </div>
            <aside className={`sidebar rail ${open ? 'open' : ''}`}>
                <div className="brand" title={name}>
                    <div className="brand-mark">{name.slice(0, 1)}</div>
                    <div className="nav-text">{name}<small>Code CRM</small></div>
                </div>
                {link('/code', 'Tree', Icon.tree)}
                {link('/projects', 'Projects', Icon.projects)}
                {link('/team', 'People', Icon.people)}
                {isManager ? link('/settings', 'Settings', Icon.settings) : null}
                <div className="sidebar-foot">
                    <NavLink to={`/team/${me.id}`} className="nav-link me-link" title={`${me.name} · ${isManager ? 'manager' : 'developer'}`}>
                        <Avatar name={me.name} email={me.email} github={me.githubLogin} size={26} />
                        <span className="nav-text">{me.name}</span>
                    </NavLink>
                    <ThemeToggle />
                    <button className="nav-link" style={{ border: 0, background: 'none', cursor: 'pointer', textAlign: 'left' }} onClick={signOut} title="Sign out" aria-label="Sign out"><Icon.out /> <span className="nav-text">Sign out</span></button>
                </div>
            </aside>
            {open ? <div className="overlay" style={{ zIndex: 35 }} onClick={() => setOpen(false)} /> : null}
            <main className={`main ${full ? 'main-full' : ''}`}>
                <Routes>
                    <Route path="/code" element={<CodeTree />} />
                    <Route path="/projects" element={<Projects />} />
                    <Route path="/team" element={<Team />} />
                    <Route path="/team/:id" element={<Profile />} />
                    <Route path="/records/:id" element={<RecordPage />} />
                    {isManager ? <Route path="/settings/*" element={<Settings />} /> : null}
                    <Route path="*" element={<Navigate to="/code" replace />} />
                </Routes>
            </main>
        </div>
    )
}

/** Light or dark, remembered on this device. Dark is the default. */
function ThemeToggle()
{
    const [theme, setTheme] = useState(() => document.documentElement.dataset.theme === 'light' ? 'light' : 'dark')
    const flip = () => {
        const next = theme === 'dark' ? 'light' : 'dark'
        document.documentElement.dataset.theme = next
        try { localStorage.setItem('studio-theme', next) } catch { /* private mode: still switches for this visit */ }
        setTheme(next)
    }
    const label = theme === 'dark' ? 'Light mode' : 'Dark mode'
    return (
        <button className="nav-link" style={{ border: 0, background: 'none', cursor: 'pointer', textAlign: 'left' }} onClick={flip} title={label} aria-label={label}>
            {theme === 'dark' ? <Icon.sun /> : <Icon.moon />} <span className="nav-text">{label}</span>
        </button>
    )
}
