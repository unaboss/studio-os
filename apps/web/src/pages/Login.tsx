import { useEffect, useState, type FormEvent } from 'react'
import { api } from '../api.ts'

interface LoginInfo { demo: boolean; signup?: boolean; accounts: { label: string; email: string; password: string }[] }

export function Login({ onSignedIn }: { onSignedIn: () => void })
{
    const [email, setEmail] = useState('')
    const [password, setPassword] = useState('')
    const [error, setError] = useState<string | null>(null)
    const [busy, setBusy] = useState(false)
    const [info, setInfo] = useState<LoginInfo | null>(null)
    const [mode, setMode] = useState<'in' | 'up'>('in')
    const [name, setName] = useState('')
    const [team, setTeam] = useState('')
    const [github, setGithub] = useState('')
    useEffect(() => {
        api<LoginInfo>('/api/login-info').then(setInfo).catch(() => {})
    }, [])

    const signIn = async (e?: FormEvent, creds?: { email: string; password: string }) => {
        e?.preventDefault()
        setBusy(true)
        setError(null)
        try {
            await api('/api/login', { body: creds ?? { email, password } })
            window.history.replaceState(null, '', '/')
            onSignedIn()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    const signUp = async (e: FormEvent) => {
        e.preventDefault()
        setBusy(true)
        setError(null)
        try {
            await api('/api/signup', { body: { company: team.trim() || undefined, name, email, password } })
            const login = github.trim().replace(/^@/, '').replace(/^https?:\/\/github\.com\//i, '').replace(/\/.*$/, '')
            if (login) await api('/api/me', { method: 'PATCH', body: { githubLogin: login } }).catch(() => {})
            window.history.replaceState(null, '', '/code')
            onSignedIn()
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(false)
        }
    }

    return (
        <div className="login">
            <div className="login-art">
                <div className="row"><div className="brand-mark" style={{ background: 'rgb(255 255 255 / 0.18)' }}>S</div><strong>Studio OS</strong></div>
                <div className="stack" style={{ gap: 16 }}>
                    <h1>Every project's code, growing in one place.</h1>
                    <p>A code CRM for software teams. Each client project is a living tree: branches grow, merged work grafts back in, and any commit opens the code as it was. An agent on Vultr explains what changed, and the people page shows what everyone is building.</p>
                </div>
                <p className="small">Built on Vultr · MIT licensed</p>
            </div>
            <div className="login-form">
                {mode === 'up' ? (
                    <form onSubmit={signUp}>
                        <h1>Start your own space</h1>
                        <p className="muted">Solo or with a team. Plant your GitHub repos and watch them grow.</p>
                        {error ? <div className="error-box">{error}</div> : null}
                        <label className="field"><span>Your name</span><input className="input" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} required /></label>
                        <label className="field"><span>Email</span><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
                        <label className="field"><span>Password <span className="hint">10 or more characters</span></span><input className="input" type="password" autoComplete="new-password" minLength={10} value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
                        <label className="field"><span>GitHub username <span className="hint">optional, puts your face on your commits</span></span><input className="input" placeholder="octocat" value={github} onChange={(e) => setGithub(e.target.value)} /></label>
                        <label className="field"><span>Team name <span className="hint">leave blank to work solo</span></span><input className="input" placeholder="e.g. North Tech" value={team} onChange={(e) => setTeam(e.target.value)} /></label>
                        <button className="btn primary block" disabled={busy}>{busy ? 'Setting up…' : 'Create my space'}</button>
                        <div className="small muted" style={{ textAlign: 'center' }}>Already have one? <button type="button" className="link-btn" style={{ margin: 0 }} onClick={() => { setMode('in'); setError(null) }}>Sign in</button></div>
                    </form>
                ) : (
                <form onSubmit={signIn}>
                    <h1>Sign in</h1>
                    {info?.demo ? (
                        <>
                            <p className="muted">This is a demo studio with made-up data. Pick a side to look around:</p>
                            <div className="demo-accounts">
                                {info.accounts.map((a) => (
                                    <button type="button" key={a.email} disabled={busy} onClick={() => signIn(undefined, a)}>
                                        <strong>{a.label}</strong>
                                        <span className="small muted">{a.label === 'Manager' ? 'Every project, every person' : 'The trees and your own work'}</span>
                                    </button>
                                ))}
                            </div>
                            <div className="faint small" style={{ textAlign: 'center' }}>or sign in with your own account</div>
                        </>
                    ) : null}
                    {error ? <div className="error-box">{error}</div> : null}
                    <label className="field"><span>Email</span><input className="input" type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required /></label>
                    <label className="field"><span>Password</span><input className="input" type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></label>
                    <button className="btn primary block" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
                    {info?.signup !== false ? (
                        <div className="signup-cta">
                            <span>New here?</span>
                            <button type="button" className="btn block" onClick={() => { setMode('up'); setError(null) }}>Start your own space, solo or with a team</button>
                        </div>
                    ) : null}
                </form>
                )}
            </div>
        </div>
    )
}
