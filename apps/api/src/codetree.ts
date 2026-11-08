// The code tree: each project's repository kept on the VM's own disk, so the
// tree is always current and reading old code never waits on GitHub.
//
// Remote repos are bare, blob-less clones (history first, file contents on
// first read) refreshed every few minutes. The demo studio's repos are local
// folders made by demo-repos.ts.
import { execFile } from 'node:child_process'
import { mkdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export interface TreeCommit
{
    readonly sha: string
    readonly parents: readonly string[]
    readonly author: string
    readonly email: string
    readonly date: string
    readonly subject: string
}

export interface TreeGraph
{
    readonly repo: string
    readonly defaultBranch: string
    readonly branches: readonly { name: string; sha: string }[]
    readonly commits: readonly TreeCommit[]
    readonly fetchedAt: string | null
}

export interface ChangedFile
{
    readonly path: string
    readonly added: number | null
    readonly removed: number | null
}

export interface CommitDetail
{
    readonly commit: TreeCommit & { body: string }
    readonly files: readonly ChangedFile[]
    /** Unified diff against the first parent, cut at about 120 kB. */
    readonly patch: string
    readonly truncated: boolean
}

export interface FileAt
{
    readonly path: string
    readonly content: string
    readonly binary: boolean
    readonly truncated: boolean
    readonly size: number
}

export interface CodeRepos
{
    graph(repo: string): Promise<TreeGraph>
    files(repo: string, sha: string): Promise<string[]>
    file(repo: string, sha: string, path: string): Promise<FileAt>
    /** A file's raw bytes at a commit, for serving a site as it was then. Up to 5 MB. */
    raw(repo: string, sha: string, path: string): Promise<Buffer>
    commit(repo: string, sha: string): Promise<CommitDetail>
    /** Everything between two commits, newest first: a branch since it forked. */
    range(repo: string, base: string, head: string): Promise<{ commits: TreeCommit[]; files: ChangedFile[]; patch: string }>
    /** Fetches every repo already on disk. The server runs this every few minutes. */
    refreshAll(): Promise<void>
}

export interface CodeReposOptions
{
    /** Where clones live, e.g. /data/code. */
    readonly dir: string
    /** Local repos by name, for the demo studio. */
    readonly local?: Readonly<Record<string, string>>
    /** Lets clones of private repos authenticate. */
    readonly token?: string | undefined
    /** How stale a clone may get before a read fetches first. */
    readonly maxAgeMs?: number
}

export const REPO_NAME = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/
const SHA = /^[0-9a-f]{7,40}$/
const SEP = '\x1f'
const MAX_COMMITS = 400
const MAX_FILE = 200_000
const MAX_PATCH = 120_000
const MAX_RAW = 5_000_000

export class CodeError extends Error {}

export function codeRepos(opts: CodeReposOptions): CodeRepos
{
    const fetchedAt = new Map<string, number>()
    const pending = new Map<string, Promise<string>>()
    const maxAge = opts.maxAgeMs ?? 5 * 60_000

    const git = async (cwd: string, args: string[], maxBuffer = 16 * 1024 * 1024): Promise<string> => {
        const auth = opts.token ? ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.token}`).toString('base64')}`] : []
        const { stdout } = await exec('git', [...auth, '-C', cwd, ...args], {
            maxBuffer,
            timeout: 60_000,
            env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
        })
        return stdout
    }

    const cloneDir = (repo: string) => join(opts.dir, 'cache', repo.replace('/', '__') + '.git')

    async function fetchNow(repo: string, dir: string): Promise<void>
    {
        await git(dir, ['fetch', '--prune', '--quiet', 'origin', '+refs/heads/*:refs/heads/*'])
        fetchedAt.set(repo, Date.now())
    }

    /** The folder for a repo, cloning it the first time and fetching when stale. */
    async function open(repo: string): Promise<string>
    {
        if (!REPO_NAME.test(repo)) throw new CodeError('Repos are written owner/name')
        const local = opts.local?.[repo]
        if (local) return local
        const dir = cloneDir(repo)
        const inFlight = pending.get(repo)
        if (inFlight) return inFlight
        const job = (async () => {
            const exists = await stat(join(dir, 'HEAD')).then(() => true, () => false)
            if (!exists) {
                await mkdir(join(opts.dir, 'cache'), { recursive: true })
                try {
                    await exec('git', [
                        ...(opts.token ? ['-c', `http.https://github.com/.extraheader=AUTHORIZATION: basic ${Buffer.from(`x-access-token:${opts.token}`).toString('base64')}`] : []),
                        // History first, file contents on first read, and only the last 500 commits of each branch,
                        // so even a very large repo plants in seconds and stays small on disk.
                        'clone', '--bare', '--filter=blob:none', '--depth=500', '--no-single-branch', '--no-tags', '--quiet', `https://github.com/${repo}.git`, dir,
                    ], { timeout: 180_000, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
                } catch {
                    throw new CodeError(`Could not reach github.com/${repo}. Check the name, or give the server a GITHUB_TOKEN for private repos.`)
                }
                fetchedAt.set(repo, Date.now())
            } else if (Date.now() - (fetchedAt.get(repo) ?? 0) > maxAge) {
                await fetchNow(repo, dir).catch((err) => console.error(`code tree: fetch ${repo} failed`, err.message))
            }
            return dir
        })().finally(() => pending.delete(repo))
        pending.set(repo, job)
        return job
    }

    const checkPath = (path: string) => {
        if (!path || path.startsWith('-') || path.startsWith('/') || path.includes('\0') || path.split('/').includes('..')) throw new CodeError('Not a file path')
    }

    const checkSha = (sha: string) => {
        if (!SHA.test(sha)) throw new CodeError('Not a commit id')
    }

    const parseCommit = (line: string): TreeCommit => {
        const [sha, parents, author, email, date, ...subject] = line.split(SEP)
        return { sha: sha!, parents: parents ? parents.split(' ') : [], author: author!, email: email!, date: date!, subject: subject.join(SEP) }
    }

    return {
        async graph(repo)
        {
            const dir = await open(repo)
            const head = (await git(dir, ['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => 'main')).trim() || 'main'
            const refs = (await git(dir, ['for-each-ref', 'refs/heads', `--format=%(refname:short)${SEP}%(objectname)`]))
                .split('\n').filter(Boolean).map((l) => {
                    const [name, sha] = l.split(SEP)
                    return { name: name!, sha: sha! }
                })
            const log = refs.length
                ? await git(dir, ['log', '--branches', '--date-order', `-n${MAX_COMMITS}`, `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s`])
                : ''
            const commits = log.split('\n').filter(Boolean).map(parseCommit)
            const defaultBranch = refs.some((r) => r.name === head) ? head : (refs.find((r) => r.name === 'main' || r.name === 'master')?.name ?? refs[0]?.name ?? head)
            const at = fetchedAt.get(repo)
            return { repo, defaultBranch, branches: refs, commits, fetchedAt: opts.local?.[repo] ? new Date().toISOString() : at ? new Date(at).toISOString() : null }
        },

        async files(repo, sha)
        {
            checkSha(sha)
            const dir = await open(repo)
            const out = await git(dir, ['ls-tree', '-r', '-z', '--name-only', sha])
            return out.split('\0').filter(Boolean).slice(0, 5000)
        },

        async file(repo, sha, path)
        {
            checkSha(sha)
            checkPath(path)
            const dir = await open(repo)
            const size = Number((await git(dir, ['cat-file', '-s', `${sha}:${path}`]).catch(() => { throw new CodeError('That file is not in this commit') })).trim())
            const raw = await git(dir, ['cat-file', 'blob', `${sha}:${path}`], Math.max(size + 1024, 1024 * 1024))
            const binary = raw.slice(0, 8000).includes('\0')
            return { path, size, binary, truncated: raw.length > MAX_FILE, content: binary ? '' : raw.slice(0, MAX_FILE) }
        },

        async raw(repo, sha, path)
        {
            checkSha(sha)
            checkPath(path)
            const dir = await open(repo)
            const size = Number((await git(dir, ['cat-file', '-s', `${sha}:${path}`]).catch(() => { throw new CodeError('That file is not in this commit') })).trim())
            if (size > MAX_RAW) throw new CodeError('That file is too big to preview')
            const { stdout } = await exec('git', ['-C', dir, 'cat-file', 'blob', `${sha}:${path}`], {
                encoding: 'buffer', maxBuffer: MAX_RAW + 1024, timeout: 60_000,
                env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
            })
            return stdout
        },

        async commit(repo, sha)
        {
            checkSha(sha)
            const dir = await open(repo)
            const meta = await git(dir, ['log', '-1', `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s${SEP}%b`, sha])
            const parts = meta.split(SEP)
            const c = parseCommit(parts.slice(0, 6).join(SEP))
            const body = parts.slice(6).join(SEP).trim()
            const base = c.parents[0]
            const numstat = base
                ? await git(dir, ['diff', '--numstat', base, sha])
                : await git(dir, ['show', '--format=', '--numstat', sha])
            const files = numstat.split('\n').filter(Boolean).map((l) => {
                const [a, r, ...p] = l.split('\t')
                return { path: p.join('\t'), added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r) }
            })
            const fullPatch = base
                ? await git(dir, ['diff', '--unified=3', '--no-color', base, sha])
                : await git(dir, ['show', '--format=', '--unified=3', '--no-color', sha])
            return { commit: { ...c, body }, files, patch: fullPatch.slice(0, MAX_PATCH), truncated: fullPatch.length > MAX_PATCH }
        },

        async range(repo, base, head)
        {
            checkSha(base)
            checkSha(head)
            const dir = await open(repo)
            const log = await git(dir, ['log', '-n100', `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%aI${SEP}%s`, `${base}..${head}`])
            const numstat = await git(dir, ['diff', '--numstat', base, head])
            const files = numstat.split('\n').filter(Boolean).map((l) => {
                const [a, r, ...p] = l.split('\t')
                return { path: p.join('\t'), added: a === '-' ? null : Number(a), removed: r === '-' ? null : Number(r) }
            })
            const patch = (await git(dir, ['diff', '--unified=3', '--no-color', base, head])).slice(0, MAX_PATCH)
            return { commits: log.split('\n').filter(Boolean).map(parseCommit), files, patch }
        },

        async refreshAll()
        {
            for (const repo of [...fetchedAt.keys()]) {
                if (opts.local?.[repo]) continue
                await fetchNow(repo, cloneDir(repo)).catch((err) => console.error(`code tree: fetch ${repo} failed`, err.message))
            }
        },
    }
}
