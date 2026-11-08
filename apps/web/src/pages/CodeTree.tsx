import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ago, api, useApi } from '../api.ts'
import { Avatar, realLogin } from '../avatar.tsx'
import { Icon } from '../icons.tsx'
import { Pill, useStudio } from '../ui.tsx'

export { colour, initials } from '../avatar.tsx'

// ---- Data from /api/code ----

interface Commit { sha: string; parents: string[]; author: string; email: string; date: string; subject: string }
interface Graph { repo: string; defaultBranch: string; branches: { name: string; sha: string }[]; commits: Commit[]; fetchedAt: string | null }
export interface RepoRow
{
    projectId: string; project: string; status: string; repo: string; clientId: string; client: string
    health?: 'attention' | 'watch' | 'good'; reasons?: string[]; openBranches?: number; lastCommit?: string | null
}
interface CommitDetail { commit: Commit & { body: string }; files: { path: string; added: number | null; removed: number | null }[]; patch: string; truncated: boolean }
interface FileAt { path: string; content: string; binary: boolean; truncated: boolean; size: number }
interface PersonLite { id: string; name: string; email: string; github: string | null }
interface Preview { url: string | null; reason?: string }

// ---- Turning history into a tree ----

/** One limb of the tree: the trunk (the default branch) or a branch growing off it. */
interface Limb
{
    id: number
    name: string
    /** Oldest first. */
    commits: string[]
    /** Where it grows from; null for the trunk. */
    fork: string | null
    /** The merge commit it grafts back into, if it was merged. */
    mergeInto: string | null
    open: boolean
    pr: string | null
    side: 1 | -1
    lane: number
}

interface Placed { x: number; y: number; limb: number }

const TOP = 96
const BOTTOM = 150

const short = (name: string) => (name.length > 26 ? `${name.slice(0, 25)}…` : name)
const tagLabel = (l: Limb) => (l.id === 0 ? l.name : `${short(l.name)}${l.open ? '' : l.pr ? `  ${l.pr}` : ''}`)
const tagWidth = (l: Limb) => tagLabel(l).length * 7 + 22

function grow(g: Graph, minWidth = 0, minHeight = 0)
{
    const asc = [...g.commits].reverse()
    // Fit the history to the screen when it can; a long history scrolls.
    const room = minHeight ? (minHeight - TOP - BOTTOM) / Math.max(1, asc.length) : 560 / Math.max(1, asc.length)
    const ROW = Math.round(Math.min(64, Math.max(28, room)))
    const index = new Map(asc.map((c, i) => [c.sha, i]))
    const bySha = new Map(asc.map((c) => [c.sha, c]))
    const owner = new Map<string, number>()
    const limbs: Limb[] = []

    const walk = (start: string | undefined, name: string, open: boolean, mergeInto: string | null, pr: string | null): Limb | null => {
        const own: string[] = []
        let s = start
        while (s && bySha.has(s) && !owner.has(s)) {
            own.push(s)
            s = bySha.get(s)!.parents[0]
        }
        if (!own.length) return null
        const limb: Limb = { id: limbs.length, name, commits: own.reverse(), fork: s && owner.has(s) ? s : null, mergeInto, open, pr, side: 1, lane: 0 }
        for (const sha of limb.commits) owner.set(sha, limb.id)
        limbs.push(limb)
        return limb
    }

    const head = g.branches.find((b) => b.name === g.defaultBranch)?.sha ?? asc.at(-1)?.sha
    walk(head, g.defaultBranch, true, null, null)

    for (const ref of g.branches.filter((b) => b.name !== g.defaultBranch).sort((a, b) => (index.get(a.sha) ?? 0) - (index.get(b.sha) ?? 0))) {
        walk(ref.sha, ref.name, true, null, null)
    }

    // Branches that were merged and deleted live on as the second parent of a merge.
    for (let changed = true; changed;) {
        changed = false
        for (const c of asc) {
            if (!owner.has(c.sha)) continue
            for (const p of c.parents.slice(1)) {
                const known = owner.get(p)
                if (known !== undefined) {
                    const limb = limbs[known]!
                    if (known !== 0 && limb.commits.at(-1) === p && !limb.mergeInto) limb.mergeInto = c.sha
                    continue
                }
                const prMatch = /Merge pull request #(\d+) from [^/\s]+\/(\S+)/.exec(c.subject)
                const branchMatch = /Merge branch '([^']+)'/.exec(c.subject)
                const name = prMatch ? prMatch[2]! : branchMatch ? branchMatch[1]! : 'merged branch'
                if (walk(p, name, false, c.sha, prMatch ? `#${prMatch[1]}` : null)) changed = true
            }
        }
    }

    // Lanes: each limb takes the nearest free lane on the side with more room.
    const taken: { side: 1 | -1; lane: number; from: number; to: number }[] = []
    const span = (l: Limb) => {
        const first = index.get(l.fork ?? l.commits[0]!) ?? 0
        const last = Math.max(index.get(l.commits.at(-1)!) ?? 0, l.mergeInto ? index.get(l.mergeInto) ?? 0 : 0)
        return [first, last + 1.5] as const
    }
    let flip: 1 | -1 = 1
    for (const limb of limbs.slice(1).sort((a, b) => span(a)[0] - span(b)[0])) {
        const [from, to] = span(limb)
        const free = (side: 1 | -1) => {
            for (let lane = 1; ; lane++) if (!taken.some((t) => t.side === side && t.lane === lane && t.from < to && from < t.to)) return lane
        }
        const right = free(1)
        const left = free(-1)
        const side: 1 | -1 = right < left ? 1 : left < right ? -1 : flip
        flip = side === 1 ? -1 : 1
        limb.side = side
        limb.lane = side === 1 ? right : left
        taken.push({ side, lane: limb.lane, from, to })
    }

    // Spread the branches out to use the screen, within reason.
    const lanes = Math.max(1, ...limbs.slice(1).map((l) => l.lane))
    const LANE = minWidth ? Math.round(Math.min(124, Math.max(76, (minWidth / 2 - 300) / lanes))) : 78
    const reach = (side: 1 | -1) => Math.max(160, ...limbs.filter((l) => l.id !== 0 && l.side === side).map((l) => l.lane * LANE + 40 + tagWidth(l)))
    const left = reach(-1) + 90
    const right = reach(1) + 40
    const extra = Math.max(0, minWidth - left - right)
    const cx = left + extra / 2
    const width = left + right + extra
    const height = Math.max(minHeight, asc.length * ROW + TOP + BOTTOM)
    const groundY = height - BOTTOM + 12
    const yOf = (sha: string) => groundY - 36 - (index.get(sha) ?? 0) * ROW

    const at = new Map<string, Placed>()
    limbs[0]?.commits.forEach((sha) => {
        const i = index.get(sha) ?? 0
        at.set(sha, { x: cx + Math.sin(i * 0.45) * 3, y: yOf(sha), limb: 0 })
    })
    for (const limb of limbs.slice(1)) {
        limb.commits.forEach((sha, k) => {
            const r = k === 0 ? 0.72 : 1
            at.set(sha, { x: cx + limb.side * (limb.lane * LANE * r + Math.min(k, 5) * 4), y: yOf(sha), limb: limb.id })
        })
    }
    return { asc, index, bySha, limbs, at, cx, width, height, groundY, ROW }
}

type Grown = ReturnType<typeof grow>

/** The history a commit stands on, oldest first: what you watch grow. */
function lineage(t: Grown, tip: string): string[]
{
    const out: string[] = []
    for (let s: string | undefined = tip; s && t.bySha.has(s); s = t.bySha.get(s)!.parents[0]) out.push(s)
    return out.reverse()
}

// ---- Drawing ----

/** A tapering stroke through points: thick where it starts, fine at the tip. */
function Taper({ points, from, to, className }: { points: [number, number][]; from: number; to: number; className: string })
{
    const parts: ReactNode[] = []
    for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1]!
        const [x1, y1] = points[i]!
        const w = from + (to - from) * (i / Math.max(1, points.length - 1))
        const my = (y0 + y1) / 2
        parts.push(<path key={`${x1},${y1}`} className={`t-seg ${className}`} pathLength={1} d={`M${x0},${y0} C${x0},${my} ${x1},${my} ${x1},${y1}`} strokeWidth={w} />)
    }
    return <>{parts}</>
}

function Tree({ g, t, upto, selected, onSelect, who, box }: {
    g: Graph; t: Grown; upto: number; selected: string | null; onSelect: (sha: string) => void; who: string | null; box: HTMLDivElement | null
})
{
    const { limbs, at, cx, width, height, groundY, bySha, index, ROW } = t
    const seen = (sha: string) => (index.get(sha) ?? 0) <= upto

    useEffect(() => {
        // Open on the trunk, with the newest growth in view.
        if (!box) return
        if (width > box.clientWidth) box.scrollLeft = cx - box.clientWidth / 2
    }, [box, g, width, cx])

    // Keep the playing commit in view.
    useEffect(() => {
        if (!box || !selected || !at.has(selected)) return
        const p = at.get(selected)!
        const pad = 140
        if (p.y < box.scrollTop + pad || p.y > box.scrollTop + box.clientHeight - pad) box.scrollTo({ top: p.y - box.clientHeight / 2, behavior: 'smooth' })
    }, [selected, box, at])

    const trunk = limbs[0]!
    const trunkVisible = trunk.commits.filter(seen)
    const trunkPts: [number, number][] = [[cx, groundY], ...trunkVisible.map((s) => [at.get(s)!.x, at.get(s)!.y] as [number, number])]
    const dateEvery = Math.max(1, Math.round(150 / ROW))
    const months = new Set<string>()

    return (
        <svg className="tree-svg" width={width} height={height} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Commit tree for ${g.repo}`}>
            <defs>
                <radialGradient id="tree-glow"><stop offset="0" className="glow-stop" stopOpacity="0.11" /><stop offset="1" className="glow-stop" stopOpacity="0" /></radialGradient>
                <linearGradient id="tree-ground" x1="0" x2="1"><stop offset="0" className="ground-stop" stopOpacity="0" /><stop offset="0.5" className="ground-stop" stopOpacity="1" /><stop offset="1" className="ground-stop" stopOpacity="0" /></linearGradient>
            </defs>

            {/* Time, quietly, down the left. */}
            {t.asc.map((c, i) => {
                const month = c.date.slice(0, 7)
                const show = i % dateEvery === 0 || !months.has(month)
                months.add(month)
                if (!show || i > upto) return null
                const y = groundY - 36 - i * ROW
                return (
                    <g key={c.sha} className="t-time">
                        <line x1={box ? box.scrollLeft + 76 : 76} x2={width} y1={y} y2={y} />
                        <text x={box ? box.scrollLeft + 24 : 24} y={y + 4}>{new Date(c.date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</text>
                    </g>
                )
            })}

            {/* A soft light behind live growth. */}
            {limbs.filter((l) => l.open && l.commits.some(seen)).map((l) => {
                const tip = at.get(l.commits.filter(seen).at(-1)!)!
                return <circle key={l.id} cx={tip.x} cy={tip.y} r={l.id === 0 ? 150 : 90} fill="url(#tree-glow)" />
            })}

            {/* Ground: one hairline and fine roots. */}
            <line x1={cx - 260} x2={cx + 260} y1={groundY} y2={groundY} stroke="url(#tree-ground)" strokeWidth={1} />
            {[-1, 1].map((d) => [0, 1, 2].map((r) => (
                <path key={`${d}${r}`} className="t-root" d={`M${cx + d * 2},${groundY} C${cx + d * (8 + r * 8)},${groundY + 6 + r * 3} ${cx + d * (24 + r * 20)},${groundY + 8 + r * 5} ${cx + d * (40 + r * 34)},${groundY + 12 + r * 7}`} strokeWidth={2.2 - r * 0.6} />
            )))}

            {/* Grafts: merged work joining back. */}
            {limbs.slice(1).filter((l) => l.mergeInto && at.has(l.mergeInto) && seen(l.mergeInto)).map((l) => {
                const tip = at.get(l.commits.at(-1)!)!
                const into = at.get(l.mergeInto!)!
                return <path key={`m${l.id}`} className="t-seg t-graft" pathLength={1} d={`M${tip.x},${tip.y} C${tip.x},${tip.y - 22} ${into.x + l.side * 22},${into.y + 8} ${into.x},${into.y}`} strokeWidth={1.4} />
            })}

            {/* Branches, then the trunk over them. */}
            {limbs.slice(1).map((l) => {
                const vis = l.commits.filter(seen)
                if (!vis.length) return null
                const base = l.fork && at.has(l.fork) ? at.get(l.fork)! : at.get(l.commits[0]!)!
                const pts: [number, number][] = [[base.x, base.y], ...vis.map((s) => [at.get(s)!.x, at.get(s)!.y] as [number, number])]
                const live = l.open || !l.mergeInto || !seen(l.mergeInto)
                return <Taper key={l.id} points={pts} from={live ? 5 : 4} to={live ? 2 : 1.5} className={live ? 't-limb open' : 't-limb merged'} />
            })}
            <Taper points={trunkPts} from={12} to={3.5} className="t-trunk" />

            {/* One node per commit. */}
            {limbs.map((l) => l.commits.filter(seen).map((sha) => {
                const p = at.get(sha)!
                const c = bySha.get(sha)!
                const live = l.id !== 0 && (l.open || !l.mergeInto || !seen(l.mergeInto))
                const kind = l.id === 0 ? 'trunk' : live ? 'open' : 'merged'
                return (
                    <g key={sha} className={`t-node ${kind} ${selected === sha ? 'on' : ''} ${who && c.email !== who ? 'dim' : ''}`} onClick={() => onSelect(sha)}>
                        <title>{`${c.subject}\n${c.author} · ${new Date(c.date).toLocaleString('en-ZA')}`}</title>
                        <circle className="t-halo" cx={p.x} cy={p.y} r={15} />
                        <circle className="t-dot" cx={p.x} cy={p.y} r={l.id === 0 ? 5 : 4} />
                        <circle cx={p.x} cy={p.y} r={14} fill="transparent" />
                    </g>
                )
            }))}

            {/* Name tags at the tip of each branch. */}
            {limbs.map((l) => {
                const vis = l.commits.filter(seen)
                if (!vis.length) return null
                const tip = at.get(vis.at(-1)!)!
                const label = tagLabel(l)
                const w = tagWidth(l)
                const live = l.id !== 0 && (l.open || !l.mergeInto || !seen(l.mergeInto))
                const x = l.id === 0 ? tip.x - w / 2 : l.side === 1 ? tip.x + 14 : tip.x - 14 - w
                const y = l.id === 0 ? tip.y - 40 : tip.y - 11
                return (
                    <g key={`tag${l.id}`} className={`t-tag ${l.id === 0 ? 'trunk' : live ? 'open' : 'merged'}`} onClick={() => onSelect(vis.at(-1)!)}>
                        <title>{l.open || l.id === 0 ? l.name : `${l.name}, merged${l.pr ? ` as ${l.pr}` : ''}`}</title>
                        <rect x={x} y={y} width={w} height={22} rx={11} />
                        {l.id !== 0 ? <circle cx={x + 11} cy={y + 11} r={3} /> : null}
                        <text x={l.id === 0 ? x + w / 2 : x + 19} y={y + 15} textAnchor={l.id === 0 ? 'middle' : 'start'}>{label}</text>
                    </g>
                )
            })}
        </svg>
    )
}

// ---- The agent's plain-words explanation ----

interface Explanation { summary: string; review: string[]; model: string | null }

function Explain({ repo, sha, limb }: { repo: string; sha: string; limb: Limb | undefined })
{
    const [busy, setBusy] = useState<'commit' | 'branch' | null>(null)
    const [result, setResult] = useState<{ what: string; e: Explanation } | null>(null)
    const [error, setError] = useState<string | null>(null)
    useEffect(() => { setResult(null); setError(null) }, [sha])
    const branch = limb && limb.id !== 0 && limb.fork ? limb : null
    const ask = async (what: 'commit' | 'branch') => {
        setBusy(what)
        setError(null)
        try {
            const body = what === 'branch' && branch ? { sha: branch.commits.at(-1), base: branch.fork, branch: branch.name } : { sha }
            const e = await api<Explanation>(`/api/code/explain?repo=${encodeURIComponent(repo)}`, { body })
            setResult({ what: what === 'branch' && branch ? branch.name : 'this commit', e })
        } catch (err) {
            setError((err as Error).message)
        } finally {
            setBusy(null)
        }
    }
    return (
        <div className="explain">
            <div className="row" style={{ gap: 6 }}>
                <button className="btn sm ghost-line" disabled={!!busy} onClick={() => ask('commit')}><Icon.spark /> {busy === 'commit' ? 'Reading…' : 'Explain commit'}</button>
                {branch ? <button className="btn sm ghost-line" disabled={!!busy} onClick={() => ask('branch')}>{busy === 'branch' ? 'Reading the branch…' : 'Explain branch'}</button> : null}
            </div>
            {error ? <div className="small" style={{ color: 'var(--critical)', marginTop: 8 }}>{error}</div> : null}
            {result ? (
                <div className="explain-card">
                    <div className="small faint">The agent on {result.what}</div>
                    <p>{result.e.summary}</p>
                    {result.e.review.length ? <ul>{result.e.review.map((r) => <li key={r}>{r}</li>)}</ul> : null}
                    <div className="small faint">{result.e.model ? `Written by ${result.e.model} on Vultr Serverless Inference` : 'Written from the facts, without a model'}</div>
                </div>
            ) : null}
        </div>
    )
}

// ---- What changed, and the code as it was ----

function DiffView({ patch, path }: { patch: string; path: string })
{
    const section = useMemo(() => {
        const parts = patch.split(/^diff --git /m).slice(1)
        const hit = parts.find((p) => p.startsWith(`a/${path} `) || p.includes(` b/${path}\n`))
        return hit ? hit.split('\n').slice(1).filter((l) => !/^(index |--- |\+\+\+ |new file mode|deleted file mode)/.test(l)) : []
    }, [patch, path])
    if (!section.length) return <div className="empty small">No line changes to show for this file.</div>
    return (
        <pre className="code-view diff">
            {section.map((l, i) => (
                <div key={i} className={l.startsWith('@@') ? 'hunk' : l.startsWith('+') ? 'add' : l.startsWith('-') ? 'del' : ''}>{l || ' '}</div>
            ))}
        </pre>
    )
}

function CodeAt({ repo, sha, prefer }: { repo: string; sha: string; prefer: string | null })
{
    const q = `repo=${encodeURIComponent(repo)}&sha=${sha}`
    const files = useApi<{ files: string[] }>(`/api/code/files?${q}`)
    const [path, setPath] = useState<string | null>(null)
    const [filter, setFilter] = useState('')
    useEffect(() => {
        const list = files.data?.files ?? []
        if (!list.length) return
        setPath((cur) => (cur && list.includes(cur) ? cur : prefer && list.includes(prefer) ? prefer : list.find((f) => /readme/i.test(f)) ?? list[0]!))
    }, [files.data, prefer])
    const file = useApi<FileAt>(path ? `/api/code/file?${q}&path=${encodeURIComponent(path)}` : null)
    const shown = (files.data?.files ?? []).filter((f) => f.toLowerCase().includes(filter.toLowerCase()))
    return (
        <div className="code-at">
            <div className="code-files">
                <input className="input" placeholder={`Filter ${files.data?.files.length ?? ''} files`} value={filter} onChange={(e) => setFilter(e.target.value)} />
                <ul>
                    {shown.slice(0, 300).map((f) => (
                        <li key={f}><button className={f === path ? 'on' : ''} onClick={() => setPath(f)}>{f}</button></li>
                    ))}
                </ul>
            </div>
            <div className="code-file">
                {file.data ? (
                    <>
                        <div className="code-file-head mono">{file.data.path}<span className="faint"> · {(file.data.size / 1024).toFixed(1)} kB</span></div>
                        {file.data.binary ? <div className="empty small">A binary file.</div> : (
                            <pre className="code-view numbered">
                                {file.data.content.replace(/\n$/, '').split('\n').map((line, i) => <div key={i}><span>{i + 1}</span>{line || ' '}</div>)}
                            </pre>
                        )}
                        {file.data.truncated ? <div className="empty small">Showing the first 200 kB.</div> : null}
                    </>
                ) : <div className="empty small">{file.error ?? 'Opening…'}</div>}
            </div>
        </div>
    )
}

/** The app as it was at one commit, served from the VM. */
function PreviewFrame({ repo, sha }: { repo: string; sha: string })
{
    const p = useApi<Preview>(`/api/code/preview?repo=${encodeURIComponent(repo)}&sha=${sha}`)
    const [shown, setShown] = useState<string | null>(null)
    useEffect(() => { if (p.data?.url) setShown(p.data.url) }, [p.data?.url])
    if (p.error) return <div className="preview-empty">The preview isn't available on this server yet.<span className="small faint">{p.error}</span></div>
    if (p.data && !p.data.url) return <div className="preview-empty">Nothing to show at this commit.<span className="small faint">{p.data.reason ?? 'There is no index.html at this point in history.'}</span></div>
    return shown
        ? <iframe key={shown} className="preview-frame" src={shown} title={`The app at ${sha.slice(0, 7)}`} sandbox="allow-scripts allow-forms allow-modals allow-popups" />
        : <div className="preview-empty">Starting the app at this commit…</div>
}

function Drawer({ repo, sha, t, who, onClose, onWatch, onView, people }: {
    repo: string; sha: string; t: Grown; who: string | null; onClose: () => void; onWatch: () => void; onView: () => void; people: PersonLite[]
})
{
    const detail = useApi<CommitDetail>(`/api/code/commit?repo=${encodeURIComponent(repo)}&sha=${sha}`)
    const [tab, setTab] = useState<'changes' | 'code'>('changes')
    const [file, setFile] = useState<string | null>(null)
    useEffect(() => setFile(null), [sha])
    const d = detail.data?.commit.sha === sha ? detail.data : detail.data && !detail.loading ? detail.data : null
    const limb = t.limbs[t.at.get(sha)?.limb ?? -1]
    const c = t.bySha.get(sha)
    const person = people.find((p) => p.email.toLowerCase() === c?.email.toLowerCase())
    const current = file ?? d?.files[0]?.path ?? null
    void who
    return (
        <aside className="tree-drawer" aria-label="Commit">
            <div className="drawer-head">
                <div className="row" style={{ gap: 8 }}>
                    {limb ? <Pill tone={limb.id === 0 ? 'accent' : limb.open ? 'good' : 'neutral'}>{limb.name}{limb.id !== 0 && !limb.open ? ' · merged' : ''}</Pill> : null}
                    <span className="mono faint">{sha.slice(0, 7)}</span>
                    <button className="btn ghost sm icon-only" style={{ marginLeft: 'auto' }} onClick={onClose} aria-label="Close"><Icon.x /></button>
                </div>
                <h2>{c?.subject}</h2>
                {c ? (
                    <div className="drawer-who">
                        <Avatar name={c.author} email={c.email} github={person?.github} size={22} />
                        {person ? <Link to={`/team/${person.id}`}>{c.author}</Link> : <span>{c.author}</span>}
                        <span className="faint">· {ago(c.date)}</span>
                    </div>
                ) : null}
                <div className="drawer-actions">
                    <button className="btn primary sm" onClick={onView}><Icon.eye /> View app</button>
                    <button className="btn sm" onClick={onWatch}><Icon.play /> Watch it grow</button>
                </div>
                {d?.commit.body ? <p className="small muted" style={{ marginTop: 10, whiteSpace: 'pre-wrap' }}>{d.commit.body}</p> : null}
                <Explain repo={repo} sha={sha} limb={limb} />
            </div>
            {d ? (
                <div className="drawer-body">
                    <div className="seg">
                        <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>Changes <span className="faint">{d.files.length}</span></button>
                        <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>Code at this point</button>
                    </div>
                    {tab === 'changes' ? (
                        <>
                            <ul className="changed">
                                {d.files.map((f) => (
                                    <li key={f.path}>
                                        <button className={f.path === current ? 'on' : ''} onClick={() => setFile(f.path)}>
                                            <span className="mono ellipsis">{f.path}</span>
                                            <span className="mono"><span className="add-n">+{f.added ?? '?'}</span> <span className="del-n">−{f.removed ?? '?'}</span></span>
                                        </button>
                                    </li>
                                ))}
                            </ul>
                            {current ? <DiffView patch={d.patch} path={current} /> : <div className="empty small">This commit changed no files.</div>}
                        </>
                    ) : <CodeAt repo={repo} sha={sha} prefer={current} />}
                </div>
            ) : <div className="empty small">{detail.error ?? 'Reading the commit…'}</div>}
        </aside>
    )
}

// ---- Playback: watch the code grow, commit by commit ----

interface Playback { seq: string[]; pos: number; playing: boolean; label: string }

function Scrubber({ pb, t, onPos, onPlay, onClose, onView }: { pb: Playback; t: Grown; onPos: (n: number) => void; onPlay: (p: boolean) => void; onClose: () => void; onView?: () => void })
{
    const c = t.bySha.get(pb.seq[pb.pos]!)
    return (
        <div className="scrubber" role="group" aria-label="Playback">
            <button className="btn ghost sm icon-only" onClick={() => onPos(Math.max(0, pb.pos - 1))} aria-label="Previous commit"><Icon.prev /></button>
            <button className="btn primary sm icon-only round" onClick={() => onPlay(!pb.playing)} aria-label={pb.playing ? 'Pause' : 'Play'}>{pb.playing ? <Icon.pause /> : <Icon.play />}</button>
            <button className="btn ghost sm icon-only" onClick={() => onPos(Math.min(pb.seq.length - 1, pb.pos + 1))} aria-label="Next commit"><Icon.next /></button>
            <div className="scrub-track">
                <div className="scrub-meta">
                    <span className="ellipsis"><b>{pb.label}</b> <span className="faint">· {c?.subject}</span></span>
                    <span className="faint num">{pb.pos + 1} / {pb.seq.length}{c ? ` · ${new Date(c.date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}` : ''}</span>
                </div>
                <input type="range" min={0} max={pb.seq.length - 1} value={pb.pos} onChange={(e) => onPos(Number(e.target.value))} aria-label="Commit" />
            </div>
            {onView ? <button className="btn sm" onClick={onView}><Icon.eye /> View</button> : null}
            <button className="btn ghost sm icon-only" onClick={onClose} aria-label="Stop"><Icon.x /></button>
        </div>
    )
}

function usePlayer(pb: Playback | null, setPb: (f: (p: Playback | null) => Playback | null) => void, ms: number)
{
    useEffect(() => {
        if (!pb?.playing) return
        const id = setTimeout(() => setPb((p) => (p ? (p.pos >= p.seq.length - 1 ? { ...p, playing: false } : { ...p, pos: p.pos + 1 }) : p)), ms)
        return () => clearTimeout(id)
    }, [pb, setPb, ms])
}

/** The app itself, full screen, with its history underneath to step through. */
function Viewer({ repo, t, seq, start, label, onClose }: { repo: string; t: Grown; seq: string[]; start: number; label: string; onClose: () => void })
{
    const [pb, setPb] = useState<Playback | null>({ seq, pos: start, playing: false, label })
    usePlayer(pb, setPb, 1600)
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose()
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
    }, [onClose])
    if (!pb) return null
    const sha = pb.seq[pb.pos]!
    return (
        <div className="viewer" role="dialog" aria-modal="true" aria-label="App preview">
            <div className="viewer-bar">
                <div className="browser-dots"><i /><i /><i /></div>
                <div className="viewer-url mono"><Icon.tree /> {label} @ {sha.slice(0, 7)}</div>
                <button className="btn ghost sm icon-only" onClick={onClose} aria-label="Close preview"><Icon.x /></button>
            </div>
            <div className="viewer-stage"><PreviewFrame repo={repo} sha={sha} /></div>
            <div className="viewer-foot">
                <Scrubber pb={pb} t={t} onPos={(n) => setPb((p) => p && { ...p, pos: n, playing: false })} onPlay={(v) => setPb((p) => p && { ...p, playing: v, pos: v && p.pos >= p.seq.length - 1 ? 0 : p.pos })} onClose={onClose} />
            </div>
        </div>
    )
}

// ---- Who grew this tree ----

function Contributors({ commits, who, onPick, people }: { commits: Commit[]; who: string | null; onPick: (email: string | null) => void; people: PersonLite[] })
{
    const list = useMemo(() => {
        const by = new Map<string, { name: string; email: string; count: number; last: string }>()
        for (const c of commits) {
            const p = by.get(c.email) ?? { name: c.author, email: c.email, count: 0, last: c.date }
            p.count++
            if (c.date > p.last) p.last = c.date
            by.set(c.email, p)
        }
        return [...by.values()].sort((a, b) => b.count - a.count)
    }, [commits])
    const MAX = 9
    const find = (email: string) => people.find((p) => p.email.toLowerCase() === email.toLowerCase())
    return (
        <div className="dock">
            <span className="dock-label">{list.length} {list.length === 1 ? 'contributor' : 'contributors'}</span>
            <div className="av-stack">
                {list.slice(0, MAX).map((p) => {
                    const person = find(p.email)
                    return (
                        <div key={p.email} className={`av-item ${who === p.email ? 'on' : ''} ${who && who !== p.email ? 'dim' : ''}`}>
                            <button onClick={() => onPick(who === p.email ? null : p.email)} aria-pressed={who === p.email} aria-label={`Show ${p.name}'s commits`}>
                                <Avatar name={p.name} email={p.email} github={person?.github} size={34} ring />
                            </button>
                            <div className="av-card" role="tooltip">
                                <Avatar name={p.name} email={p.email} github={person?.github} size={44} />
                                <div>
                                    <b>{p.name}</b>
                                    <div className="small faint">{realLogin(person?.github, p.email) ? `@${person!.github}` : p.email}</div>
                                    <div className="small">{p.count} {p.count === 1 ? 'commit' : 'commits'} here · last {ago(p.last)}</div>
                                    {person ? <Link className="small" to={`/team/${person.id}`}>View profile →</Link> : null}
                                </div>
                            </div>
                        </div>
                    )
                })}
                {list.length > MAX ? <span className="av-more">+{list.length - MAX}</span> : null}
            </div>
            {who ? <button className="btn ghost sm" onClick={() => onPick(null)}>Show everyone</button> : null}
        </div>
    )
}

// ---- Project switcher ----

function Switcher({ repos, repo, onPick }: { repos: RepoRow[]; repo: string | null; onPick: (repo: string) => void })
{
    const { me, toast } = useStudio()
    const [open, setOpen] = useState(false)
    const [plant, setPlant] = useState('')
    const [busy, setBusy] = useState(false)
    const ref = useRef<HTMLDivElement>(null)
    useEffect(() => {
        if (!open) return
        const off = (e: MouseEvent) => ref.current && !ref.current.contains(e.target as Node) && setOpen(false)
        const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false)
        window.addEventListener('mousedown', off)
        window.addEventListener('keydown', esc)
        return () => { window.removeEventListener('mousedown', off); window.removeEventListener('keydown', esc) }
    }, [open])
    const cur = repos.find((r) => r.repo === repo)
    const doPlant = async () => {
        if (!plant.trim()) return
        setBusy(true)
        try {
            const r = await api<{ repo: string }>('/api/code/plant', { body: { repo: plant.trim() } })
            setPlant('')
            setOpen(false)
            onPick(r.repo)
        } catch (e) {
            toast((e as Error).message, true)
        } finally {
            setBusy(false)
        }
    }
    return (
        <div className="switcher" ref={ref}>
            <button className="switcher-btn" onClick={() => setOpen((o) => !o)} aria-expanded={open} aria-haspopup="listbox">
                <span className={`health ${cur?.health ?? 'none'}`} />
                <span className="switcher-name">
                    <b>{cur?.project ?? 'Choose a project'}</b>
                    <span className="small faint mono">{cur?.repo ?? ''}</span>
                </span>
                <Icon.down />
            </button>
            {open ? (
                <div className="switcher-menu" role="listbox">
                    <div className="menu-label">Projects</div>
                    {repos.map((r) => (
                        <button key={r.repo} role="option" aria-selected={r.repo === repo} className={r.repo === repo ? 'on' : ''} onClick={() => { setOpen(false); onPick(r.repo) }} title={r.reasons?.length ? r.reasons.join('\n') : 'All clear'}>
                            <span className={`health ${r.health ?? 'none'}`} />
                            <span className="switcher-name"><b>{r.project}</b><span className="small faint">{r.client || r.repo}</span></span>
                            {r.repo === repo ? <Icon.check /> : null}
                        </button>
                    ))}
                    {me.role === 'manager' ? (
                        <form className="plant" onSubmit={(e) => { e.preventDefault(); void doPlant() }}>
                            <div className="menu-label">Plant a repo</div>
                            <div className="row" style={{ gap: 6, flexWrap: 'nowrap' }}>
                                <input className="input" placeholder="owner/name or GitHub URL" value={plant} onChange={(e) => setPlant(e.target.value)} />
                                <button className="btn sm" disabled={busy || !plant.trim()}>{busy ? 'Planting…' : 'Plant'}</button>
                            </div>
                        </form>
                    ) : null}
                </div>
            ) : null}
        </div>
    )
}

// ---- The page: the whole screen is the tree ----

export function CodeTree()
{
    const [params, setParams] = useSearchParams()
    const list = useApi<{ enabled: boolean; repos: RepoRow[] }>('/api/code')
    const peopleApi = useApi<{ people: PersonLite[] }>('/api/code/people')
    const people = peopleApi.data?.people ?? []
    const repos = list.data?.repos ?? []
    const repo = params.get('repo') ?? (repos.find((r) => r.repo === 'demo-studio/tidepool-booking') ?? repos[0])?.repo ?? null
    const graph = useApi<Graph>(repo ? `/api/code/graph?repo=${encodeURIComponent(repo)}` : null)
    const [selected, setSelected] = useState<string | null>(null)
    const [who, setWho] = useState<string | null>(null)
    const [pb, setPb] = useState<Playback | null>(null)
    const [view, setView] = useState<{ seq: string[]; start: number; label: string } | null>(null)
    const [box, setBox] = useState<HTMLDivElement | null>(null)
    const [size, setSize] = useState({ w: 0, h: 0 })

    useEffect(() => {
        if (!box) return
        const ro = new ResizeObserver(() => setSize({ w: box.clientWidth, h: box.clientHeight }))
        ro.observe(box)
        return () => ro.disconnect()
    }, [box])

    const t = useMemo(() => (graph.data && graph.data.commits.length ? grow(graph.data, size.w, size.h) : null), [graph.data, size.w, size.h])

    useEffect(() => {
        const asked = params.get('sha')
        if (graph.data && asked && graph.data.commits.some((c) => c.sha === asked)) setSelected(asked)
        else if (selected && graph.data && !graph.data.commits.some((c) => c.sha === selected)) setSelected(null)
    }, [graph.data])

    usePlayer(pb, setPb, pb && pb.seq.length > 40 ? 160 : 650)

    const playing = pb ? pb.seq[pb.pos]! : null
    const upto = t && playing ? t.index.get(playing) ?? Infinity : Infinity
    const shown = playing && pb?.label !== 'Whole history' ? playing : selected

    const pick = useCallback((r: string) => { setSelected(null); setWho(null); setPb(null); setParams({ repo: r }) }, [setParams])

    const labelOf = (sha: string) => (t ? t.limbs[t.at.get(sha)?.limb ?? 0]?.name ?? '' : '')
    const watch = (sha: string) => {
        if (!t) return
        const seq = lineage(t, sha)
        const limb = t.limbs[t.at.get(sha)?.limb ?? 0]
        const from = limb && limb.fork ? Math.max(0, seq.indexOf(limb.fork)) : 0
        setPb({ seq, pos: from, playing: true, label: labelOf(sha) })
    }
    const replayAll = () => t && setPb({ seq: t.asc.map((c) => c.sha), pos: 0, playing: true, label: 'Whole history' })
    const openView = (sha: string) => {
        if (!t) return
        const seq = lineage(t, sha)
        setView({ seq, start: seq.length - 1, label: labelOf(sha) })
    }

    const project = repos.find((r) => r.repo === repo)
    const openBranches = t ? t.limbs.filter((l) => l.id !== 0 && l.open).length : 0
    const merged = t ? t.limbs.filter((l) => !l.open).length : 0

    let body: ReactNode = null
    if (list.data && !list.data.enabled) body = <Hint title="The code tree is off">The server needs git installed to keep repos on its disk.</Hint>
    else if (list.data && !repos.length) body = <Hint title="Plant your first tree">Open the project menu above and plant a GitHub repo, or link one to a project.</Hint>
    else if (repo && graph.error) body = <Hint title="Could not read this repo">{graph.error}</Hint>
    else if (graph.data && !graph.data.commits.length) body = <Hint title="No commits yet">Push a first commit and the tree starts growing.</Hint>
    else if (!t) body = <Hint title="Growing the tree…" />

    return (
        <div className={`tree-page ${shown ? 'has-drawer' : ''}`}>
            <div className="tree-canvas" ref={setBox}>
                {t && graph.data ? <Tree g={graph.data} t={t} upto={upto} selected={shown} onSelect={(s) => { setPb(null); setSelected(s) }} who={who} box={box} /> : null}
            </div>
            {body}

            <header className="tree-top">
                <Switcher repos={repos} repo={repo} onPick={pick} />
                {t && graph.data ? (
                    <div className="tree-stats">
                        <span><b className="num">{graph.data.commits.length}</b> commits</span>
                        <span><i className="key open" /><b className="num">{openBranches}</b> open</span>
                        <span><i className="key merged" /><b className="num">{merged}</b> merged</span>
                        {project?.reasons?.length ? <span className={`tree-flag ${project.health}`} title={project.reasons.join('\n')}><span className={`health ${project.health}`} />{project.reasons[0]}</span> : null}
                    </div>
                ) : null}
                <div className="tree-tools">
                    {graph.data?.fetchedAt ? <span className="small faint hide-sm">Synced {ago(graph.data.fetchedAt)}</span> : null}
                    <button className="btn ghost sm icon-only" onClick={graph.reload} aria-label="Refresh" title="Refresh"><Icon.refresh /></button>
                    {t ? <button className="btn sm" onClick={replayAll}><Icon.play /> Replay</button> : null}
                </div>
            </header>

            {graph.data && t ? (
                <footer className="tree-bottom">
                    {pb ? (
                        <Scrubber
                            pb={pb}
                            t={t}
                            onPos={(n) => setPb((p) => p && { ...p, pos: n, playing: false })}
                            onPlay={(v) => setPb((p) => p && { ...p, playing: v, pos: v && p.pos >= p.seq.length - 1 ? 0 : p.pos })}
                            onClose={() => { if (pb.label !== 'Whole history') setSelected(pb.seq[pb.pos]!); setPb(null) }}
                            onView={() => { setView({ seq: pb.seq, start: pb.pos, label: pb.label }); setPb((p) => p && { ...p, playing: false }) }}
                        />
                    ) : <Contributors commits={graph.data.commits} who={who} onPick={setWho} people={people} />}
                </footer>
            ) : null}

            {shown && repo && t ? (
                <Drawer
                    key={repo}
                    repo={repo}
                    sha={shown}
                    t={t}
                    who={who}
                    people={people}
                    onClose={() => { setSelected(null); setPb(null) }}
                    onWatch={() => watch(shown)}
                    onView={() => openView(shown)}
                />
            ) : null}

            {view && repo && t ? <Viewer repo={repo} t={t} seq={view.seq} start={view.start} label={view.label} onClose={() => setView(null)} /> : null}
        </div>
    )
}

function Hint({ title, children }: { title: string; children?: ReactNode })
{
    return (
        <div className="tree-hint">
            <Icon.tree />
            <strong>{title}</strong>
            {children ? <span>{children}</span> : null}
        </div>
    )
}
