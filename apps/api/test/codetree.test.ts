import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { codeRepos, type CodeRepos } from '../src/codetree.ts'
import { makeDemoRepos } from '../src/demo-repos.ts'

describe('code tree', () => {
    let dir: string
    let code: CodeRepos
    const repo = 'demo-studio/karoo-ordering'

    beforeAll(async () => {
        dir = await mkdtemp(join(tmpdir(), 'codetree-'))
        const local = await makeDemoRepos(join(dir, 'demo'), new Date('2026-11-08T12:00:00Z'))
        code = codeRepos({ dir, local })
    }, 60_000)
    afterAll(() => rm(dir, { recursive: true, force: true }))

    it('reads branches and history, newest first', async () => {
        const g = await code.graph(repo)
        expect(g.defaultBranch).toBe('main')
        expect(g.branches.map((b) => b.name).sort()).toEqual(['feature/barista-notifications', 'feature/cart-checkout', 'feature/yoco-payments', 'main'])
        expect(g.commits[0]!.subject).toBe('Verify Yoco webhook signatures')
        expect(g.commits.at(-1)!.parents).toEqual([])
        const merges = g.commits.filter((c) => c.parents.length === 2).map((c) => c.subject)
        expect(merges).toEqual(['Merge pull request #19 from demo-studio/fix/stock-sync', 'Merge pull request #18 from demo-studio/feature/menu-screen'])
    })

    it('shows what a commit changed and the code as it was then', async () => {
        const g = await code.graph(repo)
        const vat = g.commits.find((c) => c.subject === 'Cart totals with VAT')!
        const detail = await code.commit(repo, vat.sha)
        expect(detail.files).toEqual([{ path: 'src/cart.ts', added: expect.any(Number), removed: expect.any(Number) }])
        expect(detail.patch).toContain('+export const VAT_RATE = 0.15')
        const then = await code.file(repo, vat.sha, 'src/cart.ts')
        expect(then.content).toContain('vatCents')
        expect(then.content).not.toContain('exVatCents')
        const files = await code.files(repo, vat.sha)
        expect(files).toContain('src/screens/Checkout.tsx')
        expect(files).not.toContain('src/payments/yoco.ts')
    })

    it('refuses odd names, ids and paths', async () => {
        await expect(code.graph('not a repo')).rejects.toThrow('owner/name')
        await expect(code.file(repo, 'HEAD', 'README.md')).rejects.toThrow('Not a commit id')
        const g = await code.graph(repo)
        await expect(code.file(repo, g.commits[0]!.sha, '../../etc/passwd')).rejects.toThrow('Not a file path')
        await expect(code.file(repo, g.commits[0]!.sha, '--output=x')).rejects.toThrow('Not a file path')
    })
})
