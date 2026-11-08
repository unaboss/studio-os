import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ago, api, useApi } from '../api.ts'
import { Empty, PageHead, Pill } from '../ui.tsx'

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

const LANE = 84
const GROUND = 90

const short = (name: string) => (name.length > 24 ? `${name.slice(0, 23)}…` : name)
const tagLabel = (l: Limb) => (l.id === 0 ? l.name : `${short(l.name)}${l.open ? '' : l.pr ? ` · ${l.pr}` : ' · merged'}`)
const tagWidth = (l: Limb) => tagLabel(l).length * 7.6 + 18

function grow(g: Graph, minWidth = 0)
{
    const asc = [...g.commits].reverse()
    // Few commits get more room each, so a young repo still looks like a tree.
    const ROW = Math.round(Math.min(58, Math.max(34, 560 / Math.max(1, asc.length))))
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

    // Branches that still exist, oldest tip first, so older limbs sit nearer the trunk.
    const pointers = new Map<string, string[]>()
    for (const ref of g.branches.filter((b) => b.name !== g.defaultBranch).sort((a, b) => (index.get(a.sha) ?? 0) - (index.get(b.sha) ?? 0))) {
        if (!walk(ref.sha, ref.name, true, null, null)) pointers.set(ref.sha, [...(pointers.get(ref.sha) ?? []), ref.name])
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

    const maxRight = Math.max(0, ...limbs.filter((l) => l.side === 1).map((l) => l.lane))
    const maxLeft = Math.max(0, ...limbs.filter((l) => l.side === -1 && l.id !== 0).map((l) => l.lane))
    // Leave room for each branch's name tag, so no label is cut off at the edge.
    const reach = (side: 1 | -1) => Math.max(0, ...limbs.filter((l) => l.id !== 0 && l.side === side).map((l) => l.lane * LANE + 30 + 18 + tagWidth(l) + 24))
    const left = Math.max(70 + maxLeft * LANE + 150, 70 + reach(-1))
    const right = Math.max(maxRight * LANE + 230, reach(1))
    const extra = Math.max(0, minWidth - left - right)
    const cx = left + extra / 2
    const width = left + right + extra
    const height = asc.length * ROW + GROUND + 90
    const groundY = height - GROUND
    const yOf = (sha: string) => groundY - 40 - (index.get(sha) ?? 0) * ROW

    const at = new Map<string, Placed>()
    limbs[0]?.commits.forEach((sha) => {
        const i = index.get(sha) ?? 0
        at.set(sha, { x: cx + Math.sin(i * 0.55) * 6, y: yOf(sha), limb: 0 })
    })
    for (const limb of limbs.slice(1)) {
        limb.commits.forEach((sha, k) => {
            const reach = k === 0 ? 0.78 : 1
            at.set(sha, { x: cx + limb.side * (limb.lane * LANE * reach + Math.min(k, 6) * 5), y: yOf(sha), limb: limb.id })
        })
    }
    return { asc, index, bySha, limbs, at, pointers, cx, width, height, groundY, ROW }
}

// ---- Drawing ----

const BARK = '#6b4a2b'
const BARK_LIGHT = '#8d6a45'
const LEAF_OPEN = '#3f9d4f'
const LEAF_MERGED = '#2c6a3a'
const KNOT = '#c8913f'

/** A tapering stroke through points: thick where it starts, thin at the tip. */
function Taper({ points, from, to, color, dashed }: { points: [number, number][]; from: number; to: number; color: string; dashed?: boolean })
{
    const parts: ReactNode[] = []
    for (let i = 1; i < points.length; i++) {
        const [x0, y0] = points[i - 1]!
        const [x1, y1] = points[i]!
        const w = from + (to - from) * (i / Math.max(1, points.length - 1))
        const my = (y0 + y1) / 2
        parts.push(<path key={i} d={`M${x0},${y0} C${x0},${my} ${x1},${my} ${x1},${y1}`} stroke={color} strokeWidth={w} fill="none" strokeLinecap="round" strokeDasharray={dashed ? '1 7' : undefined} />)
    }
    return <>{parts}</>
}

function Leaf({ x, y, side, color, k }: { x: number; y: number; side: 1 | -1; color: string; k: number })
{
    const angle = side === 1 ? -35 - (k % 2) * 40 : 215 + (k % 2) * 40
    return (
        <g transform={`translate(${x},${y})`} opacity={0.94}>
            <path d="M0,0 C8,-9 20,-9 30,0 C20,9 8,9 0,0 Z" fill={color} transform={`rotate(${angle})`} />
            <path d="M0,0 C6,-6 14,-6 20,0 C14,6 6,6 0,0 Z" fill={color} opacity={0.75} transform={`rotate(${angle + side * 70})`} />
        </g>
    )
}

function Tree({ g, selected, onSelect, who }: { g: Graph; selected: string | null; onSelect: (sha: string) => void; who: string | null })
{
    const [box, setBox] = useState<HTMLDivElement | null>(null)
    const [minWidth, setMinWidth] = useState(0)
    useEffect(() => {
        if (!box) return
        const ro = new ResizeObserver(() => setMinWidth(box.clientWidth))
        ro.observe(box)
        return () => ro.disconnect()
    }, [box])
    const t = useMemo(() => grow(g, minWidth), [g, minWidth])
    const { limbs, at, cx, width, height, groundY, bySha, ROW } = t
    // A wide tree shrinks a little to fit; past that it scrolls, opened on the trunk.
    const scale = minWidth && width > minWidth ? Math.max(0.74, minWidth / width) : 1
    useEffect(() => {
        const wrap = box?.parentElement
        if (wrap && width * scale > wrap.clientWidth) wrap.scrollLeft = cx * scale - wrap.clientWidth / 2
    }, [box, g, width, scale, cx])
    if (!limbs.length) return <div ref={setBox}><Empty title="No commits yet">Push a first commit and the tree starts growing.</Empty></div>
    const trunk = limbs[0]!
    const trunkPts: [number, number][] = [[cx, groundY + 8], ...trunk.commits.map((s) => [at.get(s)!.x, at.get(s)!.y] as [number, number])]
    const dateEvery = Math.max(1, Math.round(170 / ROW))
    const months = new Set<string>()

    return (
        <div ref={setBox}>
        <svg className="tree-svg" width={width * scale} height={height * scale} viewBox={`0 0 ${width} ${height}`} role="img" aria-label={`Commit tree for ${g.repo}`}>
            <defs>
                <linearGradient id="soil" x1="0" x2="0" y1="0" y2="1"><stop offset="0" stopColor="#8a6a48" /><stop offset="1" stopColor="#5d4632" /></linearGradient>
                <radialGradient id="canopy"><stop offset="0" stopColor="#5fb36b" stopOpacity="0.28" /><stop offset="1" stopColor="#5fb36b" stopOpacity="0" /></radialGradient>
            </defs>

            {/* Time down the left edge, a faint line per label. */}
            {t.asc.map((c, i) => {
                const month = c.date.slice(0, 7)
                const show = i % dateEvery === 0 || !months.has(month)
                months.add(month)
                if (!show) return null
                const y = groundY - 40 - i * ROW
                return (
                    <g key={c.sha} className="tree-time">
                        <line x1={8} x2={width - 8} y1={y} y2={y} />
                        <text x={10} y={y - 5}>{new Date(c.date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'short' })}</text>
                    </g>
                )
            })}

            {/* Foliage behind the newest growth. */}
            {limbs.filter((l) => l.open).map((l) => {
                const tip = at.get(l.commits.at(-1)!)!
                return <circle key={l.id} cx={tip.x} cy={tip.y - 6} r={l.id === 0 ? 120 : 70} fill="url(#canopy)" />
            })}

            {/* Ground and roots. */}
            <rect x={0} y={groundY} width={width} height={GROUND} fill="url(#soil)" />
            <rect x={0} y={groundY - 3} width={width} height={6} fill="#6f9e4c" />
            {[-1, 1].map((d) => [0, 1].map((r) => (
                <path key={`${d}${r}`} d={`M${cx},${groundY + 6} C${cx + d * 20},${groundY + 20 + r * 14} ${cx + d * (50 + r * 40)},${groundY + 18 + r * 20} ${cx + d * (80 + r * 70)},${groundY + 34 + r * 22}`} stroke={BARK} strokeWidth={7 - r * 3} fill="none" strokeLinecap="round" opacity={0.7} />
            )))}

            {/* Grafts: merged branches joining back into what they merged into. */}
            {limbs.slice(1).filter((l) => l.mergeInto && at.has(l.mergeInto)).map((l) => {
                const tip = at.get(l.commits.at(-1)!)!
                const into = at.get(l.mergeInto!)!
                return <path key={`m${l.id}`} d={`M${tip.x},${tip.y} C${tip.x},${tip.y - 26} ${into.x + l.side * 26},${into.y + 10} ${into.x},${into.y}`} stroke={BARK_LIGHT} strokeWidth={3} fill="none" strokeLinecap="round" opacity={0.75} />
            })}

            {/* Branches, then the trunk over them. */}
            {limbs.slice(1).map((l) => {
                const base = l.fork && at.has(l.fork) ? at.get(l.fork)! : at.get(l.commits[0]!)!
                const pts: [number, number][] = [[base.x, base.y], ...l.commits.map((s) => [at.get(s)!.x, at.get(s)!.y] as [number, number])]
                return <Taper key={l.id} points={pts} from={l.open ? 10 : 8} to={l.open ? 4 : 3} color={l.open ? BARK : BARK_LIGHT} />
            })}
            <Taper points={trunkPts} from={30} to={9} color={BARK} />
            <Taper points={trunkPts.map(([x, y]) => [x - 4, y])} from={7} to={2} color={BARK_LIGHT} />

            {/* Leaves and knots: one per commit. */}
            {limbs.map((l) => l.commits.map((sha, k) => {
                const p = at.get(sha)!
                const c = bySha.get(sha)!
                const isSel = selected === sha
                return (
                    <g key={sha} className="tree-node" onClick={() => onSelect(sha)} opacity={who && c.email !== who ? 0.18 : 1}>
                        <title>{`${c.subject}\n${c.author} · ${new Date(c.date).toLocaleString('en-ZA')}`}</title>
                        {l.id !== 0 ? <Leaf x={p.x} y={p.y} side={l.side} color={l.open ? LEAF_OPEN : LEAF_MERGED} k={k} /> : null}
                        {isSel ? <circle cx={p.x} cy={p.y} r={13} fill="none" stroke="#f59e0b" strokeWidth={3.5} /> : null}
                        <circle cx={p.x} cy={p.y} r={l.id === 0 ? 7 : 5.5} fill={l.id === 0 ? KNOT : l.open ? '#e8f7e4' : '#cfe3cf'} stroke={l.id === 0 ? '#5a3d22' : BARK} strokeWidth={2} />
                        <circle cx={p.x} cy={p.y} r={16} fill="transparent" />
                    </g>
                )
            }))}

            {/* Name tags at the tip of each branch. */}
            {limbs.map((l) => {
                const tip = at.get(l.commits.at(-1)!)!
                const label = tagLabel(l)
                const w = tagWidth(l)
                const x = l.id === 0 ? tip.x - w / 2 : l.side === 1 ? tip.x + 18 : tip.x - 18 - w
                const y = l.id === 0 ? tip.y - 42 : tip.y - 13
                return (
                    <g key={`tag${l.id}`} className={`tree-tag ${l.open ? 'open' : 'merged'} ${l.id === 0 ? 'trunk' : ''}`} onClick={() => onSelect(l.commits.at(-1)!)}>
                        <title>{l.open || l.id === 0 ? l.name : `${l.name}, merged${l.pr ? ` as ${l.pr}` : ''}`}</title>
                        <rect x={x} y={y} width={w} height={24} rx={6} />
                        <text x={x + 9} y={y + 16}>{label}</text>
                    </g>
                )
            })}
        </svg>
        </div>
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
            const body = what === 'branch' && branch
                ? { sha: branch.commits.at(-1), base: branch.fork, branch: branch.name }
                : { sha }
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
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button className="btn sm" disabled={!!busy} onClick={() => ask('commit')}>{busy === 'commit' ? 'Reading…' : 'Explain this commit'}</button>
                {branch ? <button className="btn sm" disabled={!!busy} onClick={() => ask('branch')}>{busy === 'branch' ? 'Reading the branch…' : `Explain the whole branch`}</button> : null}
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

// ---- The commit panel: what changed, and the code as it was ----

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

function CommitPanel({ repo, sha, limb }: { repo: string; sha: string; limb: Limb | undefined })
{
    const detail = useApi<CommitDetail>(`/api/code/commit?repo=${encodeURIComponent(repo)}&sha=${sha}`)
    const [tab, setTab] = useState<'changes' | 'code'>('changes')
    const [file, setFile] = useState<string | null>(null)
    useEffect(() => setFile(null), [sha])
    const d = detail.data
    const current = file ?? d?.files[0]?.path ?? null
    return (
        <aside className="card code-panel">
            {d ? (
                <>
                    <div className="code-panel-head">
                        <div className="small faint">
                            {limb ? <Pill tone={limb.id === 0 ? 'accent' : limb.open ? 'good' : 'neutral'}>{limb.name}{limb.id !== 0 && !limb.open ? ' · merged' : ''}</Pill> : null}
                            <span className="mono"> {d.commit.sha.slice(0, 7)}</span>
                        </div>
                        <h2>{d.commit.subject}</h2>
                        <div className="small faint">{d.commit.author} · {ago(d.commit.date)} · {new Date(d.commit.date).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' })}</div>
                        {d.commit.body ? <p className="small" style={{ marginTop: 8, whiteSpace: 'pre-wrap' }}>{d.commit.body}</p> : null}
                        <Explain repo={repo} sha={d.commit.sha} limb={limb} />
                    </div>
                    <div className="tabs" style={{ margin: '0 16px 12px' }}>
                        <button className={tab === 'changes' ? 'on' : ''} onClick={() => setTab('changes')}>Changes · {d.files.length}</button>
                        <button className={tab === 'code' ? 'on' : ''} onClick={() => setTab('code')}>Code at this point</button>
                    </div>
                    <div style={{ padding: '0 16px 16px' }}>
                        {tab === 'changes' ? (
                            <>
                                <ul className="changed">
                                    {d.files.map((f) => (
                                        <li key={f.path}>
                                            <button className={f.path === current ? 'on' : ''} onClick={() => setFile(f.path)}>
                                                <span className="mono">{f.path}</span>
                                                <span><span className="add-n">+{f.added ?? '?'}</span> <span className="del-n">−{f.removed ?? '?'}</span></span>
                                            </button>
                                        </li>
                                    ))}
                                </ul>
                                {current ? <DiffView patch={d.patch} path={current} /> : <div className="empty small">This commit changed no files.</div>}
                            </>
                        ) : <CodeAt repo={repo} sha={d.commit.sha} prefer={current} />}
                    </div>
                </>
            ) : <div className="empty small">{detail.error ?? 'Reading the commit…'}</div>}
        </aside>
    )
}

// ---- Who grew this tree ----

const AVATAR = ['#0f766e', '#b45309', '#7c3aed', '#be123c', '#1d4ed8', '#4d7c0f', '#a16207', '#0e7490']
export const initials = (name: string) => name.split(/\s+/).filter(Boolean).slice(0, 2).map((p) => p[0]!.toUpperCase()).join('')
export const colour = (key: string) => AVATAR[[...key].reduce((h, ch) => (h * 31 + ch.charCodeAt(0)) >>> 0, 7) % AVATAR.length]!

function Contributors({ commits, who, onPick }: { commits: Commit[]; who: string | null; onPick: (email: string | null) => void })
{
    const people = useMemo(() => {
        const by = new Map<string, { name: string; email: string; count: number; last: string }>()
        for (const c of commits) {
            const p = by.get(c.email) ?? { name: c.author, email: c.email, count: 0, last: c.date }
            p.count++
            if (c.date > p.last) p.last = c.date
            by.set(c.email, p)
        }
        return [...by.values()].sort((a, b) => b.count - a.count)
    }, [commits])
    return (
        <div className="contributors card">
            <div className="spread"><span className="small faint">Contributors · tap one to light up their work</span><Link className="small" to="/team">Everyone's work →</Link></div>
            <div className="contributor-row">
                {people.map((p) => (
                    <button key={p.email} className={`contributor ${who === p.email ? 'on' : ''} ${who && who !== p.email ? 'dim' : ''}`} onClick={() => onPick(who === p.email ? null : p.email)} title={p.email}>
                        <span className="avatar" style={{ background: colour(p.email) }}>{initials(p.name)}</span>
                        <span>
                            <b>{p.name}</b>
                            <span className="small faint">{p.count} {p.count === 1 ? 'commit' : 'commits'} · last {ago(p.last)}</span>
                        </span>
                    </button>
                ))}
            </div>
        </div>
    )
}

// ---- The page ----

export function CodeTree()
{
    const [params, setParams] = useSearchParams()
    const list = useApi<{ enabled: boolean; repos: RepoRow[] }>('/api/code')
    const repos = list.data?.repos ?? []
    const repo = params.get('repo') ?? repos[0]?.repo ?? null
    const graph = useApi<Graph>(repo ? `/api/code/graph?repo=${encodeURIComponent(repo)}` : null)
    const [selected, setSelected] = useState<string | null>(null)
    const [who, setWho] = useState<string | null>(null)
    const tree = useMemo(() => (graph.data ? grow(graph.data) : null), [graph.data])

    useEffect(() => {
        // Start on the newest commit, so the panel is never empty.
        const asked = params.get('sha')
        if (graph.data && asked && graph.data.commits.some((c) => c.sha === asked)) setSelected(asked)
        else if (graph.data && (!selected || !graph.data.commits.some((c) => c.sha === selected))) setSelected(graph.data.commits[0]?.sha ?? null)
    }, [graph.data])

    const project = repos.find((r) => r.repo === repo)
    const limb = selected && tree ? tree.limbs[tree.at.get(selected)?.limb ?? -1] : undefined
    const openBranches = tree ? tree.limbs.filter((l) => l.id !== 0 && l.open).length : 0
    const merged = tree ? tree.limbs.filter((l) => !l.open).length : 0

    return (
        <div>
            <PageHead title="Code tree" sub="Main is the trunk, branches grow off it, merged work grafts back in. Tap any commit to see what changed and the code as it was." />
            {repos.length ? (
                <div className="project-switch">
                    {repos.map((r) => (
                        <button key={r.repo} className={r.repo === repo ? 'on' : ''} onClick={() => { setSelected(null); setWho(null); setParams({ repo: r.repo }) }} title={r.reasons?.length ? r.reasons.join('\n') : 'All clear'}>
                            <span className={`health ${r.health ?? 'none'}`} />
                            <span><b>{r.project}</b><span className="small faint">{r.client || r.repo}</span></span>
                        </button>
                    ))}
                </div>
            ) : null}
            {list.data && !list.data.enabled ? <Empty title="The code tree is off">The server needs git installed to keep repos on its disk.</Empty> : null}
            {list.data && list.data.enabled && !repos.length ? <Empty title="No repos linked yet">Add a GitHub repo to a project (owner/name) and its tree appears here.</Empty> : null}
            {repo && graph.error ? <Empty title="Could not read this repo">{graph.error}</Empty> : null}
            {graph.data && tree ? (
                <>
                    <div className="tree-bar small">
                        <span><b>{graph.data.commits.length}</b> commits</span>
                        <span><span className="dot open" /> <b>{openBranches}</b> open {openBranches === 1 ? 'branch' : 'branches'}</span>
                        <span><span className="dot merged" /> <b>{merged}</b> merged</span>
                        {project ? <span className="faint">{project.project}</span> : null}
                        <span className="faint" style={{ marginLeft: 'auto' }}>{graph.data.fetchedAt ? `Synced ${ago(graph.data.fetchedAt)} · the server fetches every 5 minutes` : ''}</span>
                        <button className="btn sm" onClick={graph.reload}>Refresh</button>
                    </div>
                    {project?.reasons?.length ? (
                        <div className={`health-note ${project.health}`}>
                            <span className={`health ${project.health}`} />
                            {project.reasons.join(' · ')}
                        </div>
                    ) : null}
                    <div className="code-layout">
                        <div className="card tree-wrap"><Tree g={graph.data} selected={selected} onSelect={setSelected} who={who} /></div>
                        {selected && repo ? <CommitPanel repo={repo} sha={selected} limb={limb} /> : null}
                    </div>
                    <Contributors commits={graph.data.commits} who={who} onPick={setWho} />
                </>
            ) : repo && !graph.error ? <div className="empty">Growing the tree…</div> : null}
        </div>
    )
}
