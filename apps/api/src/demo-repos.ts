// Sample git repos for the demo studio's projects, so the code tree has real
// branches, merges and code to show. Made with plain git, dated relative to
// today, and rebuilt whenever the demo is seeded. Everything here is made up.
import { execFile } from 'node:child_process'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

type Who = 'thabo' | 'lerato' | 'sipho'
const PEOPLE: Record<Who, { name: string; email: string }> = {
    thabo: { name: 'Thabo Nkosi', email: 'thabo@demo.studio' },
    lerato: { name: 'Lerato Mokoena', email: 'lerato@demo.studio' },
    sipho: { name: 'Sipho Dlamini', email: 'sipho@demo.studio' },
}

type Step =
    | { kind: 'commit'; on: string; who: Who; days: number; msg: string; files: Record<string, string> }
    | { kind: 'branch'; name: string; from: string }
    | { kind: 'merge'; from: string; into: string; who: Who; days: number; msg: string; deleteBranch?: boolean }

const c = (on: string, who: Who, days: number, msg: string, files: Record<string, string>): Step => ({ kind: 'commit', on, who, days, msg, files })
const b = (name: string, from = 'main'): Step => ({ kind: 'branch', name, from })
const m = (from: string, pr: number, who: Who, days: number, title: string): Step => ({ kind: 'merge', from, into: 'main', who, days, msg: `Merge pull request #${pr} from demo-studio/${from}\n\n${title}`, deleteBranch: true })

// ---- Karoo Coffee Roasters: online ordering app ----

const karooReadme = `# Karoo ordering

Order-ahead app for Karoo Coffee Roasters: browse the menu with live stock,
pay with Yoco, and collect at the counter.

    npm install
    npm run dev
`
const karooPkg = `{
  "name": "karoo-ordering",
  "private": true,
  "type": "module",
  "scripts": { "dev": "vite", "build": "vite build", "test": "vitest run" },
  "dependencies": { "react": "19.2.9", "react-dom": "19.2.9" },
  "devDependencies": { "vite": "7.3.1", "vitest": "3.2.7", "typescript": "5.9.3" }
}
`
const menuTypes = `export interface MenuItem {
    id: string
    name: string
    priceCents: number
    category: 'coffee' | 'tea' | 'food'
}
`
const menuSeed = `export interface MenuItem {
    id: string
    name: string
    priceCents: number
    category: 'coffee' | 'tea' | 'food'
    description?: string
}

export const MENU: MenuItem[] = [
    { id: 'flat-white', name: 'Flat white', priceCents: 3800, category: 'coffee' },
    { id: 'cortado', name: 'Cortado', priceCents: 3400, category: 'coffee' },
    { id: 'karoo-filter', name: 'Karoo filter, Ethiopia Guji', priceCents: 4200, category: 'coffee', description: 'Peach, jasmine, black tea' },
    { id: 'rooibos-latte', name: 'Rooibos latte', priceCents: 3600, category: 'tea' },
    { id: 'roosterkoek', name: 'Roosterkoek with apricot jam', priceCents: 4500, category: 'food' },
]

export const byCategory = (items: MenuItem[]) =>
    Object.groupBy(items, (item) => item.category)
`
const appV1 = `import { createRoot } from 'react-dom/client'

function App() {
    return <main><h1>Karoo Coffee</h1><p>Order ahead, skip the queue.</p></main>
}

createRoot(document.getElementById('root')!).render(<App />)
`
const menuScreen = (v: 1 | 2 | 3) => `import { MENU, byCategory } from '../menu'
${v >= 2 ? "import { useStock } from '../stock'\n" : ''}
const rands = (cents: number) => 'R' + (cents / 100).toFixed(2)

export function MenuScreen({ onAdd }: { onAdd: (id: string) => void }) {
${v >= 2 ? '    const stock = useStock()\n' : ''}    const groups = byCategory(MENU)
    return (
        <section className="menu">
            {Object.entries(groups).map(([category, items]) => (
                <div key={category}>
                    <h2>{category}</h2>
                    {items!.map((item) => (
                        <button key={item.id} className="menu-item"${v >= 2 ? ' disabled={stock[item.id] === 0}' : ''} onClick={() => onAdd(item.id)}>
                            <span>{item.name}</span>
                            <span>{rands(item.priceCents)}</span>
${v >= 2 ? `                            {stock[item.id] === 0 ? <em className="sold-out">Sold out</em> : ${v >= 3 ? 'stock[item.id] < 5 ? <em className="low">Only {stock[item.id]} left</em> : null' : 'null'}}\n` : ''}                        </button>
                    ))}
                </div>
            ))}
        </section>
    )
}
`
const stock = (v: 1 | 2) => `import { useEffect, useState } from 'react'

export type Stock = Record<string, number>

export async function fetchStock(): Promise<Stock> {
    const res = await fetch('/api/stock')
    if (!res.ok) throw new Error('Stock is unavailable')
    return res.json()
}

export function useStock(): Stock {
    const [stock, setStock] = useState<Stock>({})
    useEffect(() => {
        let alive = true
        const load = () => fetchStock().then((s) => alive && setStock(s)).catch(() => {})
        load()
${v === 2 ? '        // The baristas update stock on the counter tablet; keep the menu honest.\n        const timer = setInterval(load, 30_000)\n        return () => { alive = false; clearInterval(timer) }\n' : '        return () => { alive = false }\n'}    }, [])
    return stock
}
`
const cart = (v: 1 | 2 | 3) => `import { MENU } from './menu'

export interface CartLine { id: string; qty: number }
${v >= 2 ? '\n/** South African VAT, included in menu prices. */\nexport const VAT_RATE = 0.15\n' : ''}
export function addToCart(cart: CartLine[], id: string): CartLine[] {
    const line = cart.find((l) => l.id === id)
    return line ? cart.map((l) => (l.id === id ? { ...l, qty: l.qty + 1 } : l)) : [...cart, { id, qty: 1 }]
}

export function totals(cart: CartLine[]) {
    const totalCents = cart.reduce((sum, l) => sum + (MENU.find((i) => i.id === l.id)?.priceCents ?? 0) * l.qty, 0)
${v === 1 ? '    return { totalCents }\n' : v === 2 ? '    const vatCents = Math.round(totalCents * VAT_RATE / (1 + VAT_RATE))\n    return { totalCents, vatCents }\n' : '    // Prices include VAT, so VAT is the inclusive share, rounded once on the total.\n    const vatCents = Math.round((totalCents * VAT_RATE) / (1 + VAT_RATE))\n    return { totalCents, vatCents, exVatCents: totalCents - vatCents }\n'}}
`
const checkout = (v: 1 | 2) => `import { totals, type CartLine } from '../cart'

export function CheckoutScreen({ cart, onPay }: { cart: CartLine[]; onPay: () => void }) {
    const t = totals(cart)
    return (
        <section className="checkout${v === 2 ? ' checkout--stacked' : ''}">
            <h2>Your order</h2>
            <p className="total">Total R{(t.totalCents / 100).toFixed(2)}</p>
            <button className="pay" onClick={onPay}>Pay with card</button>
        </section>
    )
}
`
const checkoutCss = `.checkout { display: grid; grid-template-columns: 1fr auto; gap: 16px; }
/* Small phones: the pay button was pushed off screen. */
@media (max-width: 380px) {
    .checkout--stacked { grid-template-columns: 1fr; }
    .checkout .pay { position: sticky; bottom: 12px; width: 100%; }
}
`
const decision = `# 001: Card payments with Yoco

Date: 2026-10

Karoo already uses Yoco card machines at the counter, so online orders settle
into the same account and the same daily payout.

- Yoco online checkout for cards, Apple Pay and Google Pay
- Refunds from the Yoco portal for now
- Webhooks confirm payment; the app never trusts the redirect alone
`
const yoco = (v: 1 | 2) => `const API = 'https://payments.yoco.com/api'

export interface Checkout { id: string; redirectUrl: string }

export async function createCheckout(amountCents: number, orderId: string, secretKey: string): Promise<Checkout> {
    const res = await fetch(API + '/checkouts', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + secretKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ amount: amountCents, currency: 'ZAR', metadata: { orderId } }),
    })
${v === 1 ? "    if (!res.ok) throw new Error('Yoco checkout failed')\n" : "    if (res.status === 402) throw new PaymentError('declined', 'The card was declined')\n    if (!res.ok) throw new PaymentError('unavailable', 'Payments are down; try again in a minute')\n"}    return res.json()
}
${v === 2 ? `
export class PaymentError extends Error {
    constructor(readonly reason: 'declined' | 'cancelled' | 'unavailable', message: string) {
        super(message)
    }
}
` : ''}`
const webhook = `import { createHmac, timingSafeEqual } from 'node:crypto'

/** Yoco signs each webhook; reject anything that does not match. */
export function verifyWebhook(secret: string, id: string, timestamp: string, body: string, signature: string): boolean {
    const expected = createHmac('sha256', Buffer.from(secret.replace(/^whsec_/, ''), 'base64'))
        .update(\`\${id}.\${timestamp}.\${body}\`)
        .digest('base64')
    const given = signature.split(' ').map((s) => s.split(',')[1] ?? '')
    return given.some((g) => g.length === expected.length && timingSafeEqual(Buffer.from(g), Buffer.from(expected)))
}
`
const notifications = `/** Pings the counter tablet when an order is paid. First sketch. */
export function notifyBaristas(order: { id: string; name: string; items: string[] }) {
    navigator.serviceWorker?.ready.then((sw) =>
        sw.showNotification(\`Order for \${order.name}\`, { body: order.items.join(', '), tag: order.id }),
    )
}
`

const KAROO: Step[] = [
    c('main', 'thabo', 60, 'Project skeleton', { 'README.md': karooReadme, 'package.json': karooPkg, 'src/main.tsx': appV1, 'src/menu.ts': menuTypes, '.gitignore': 'node_modules\ndist\n' }),
    c('main', 'thabo', 57, 'Menu data model and launch menu', { 'src/menu.ts': menuSeed }),
    b('feature/menu-screen'),
    c('feature/menu-screen', 'lerato', 55, 'Menu screen layout', { 'src/screens/Menu.tsx': menuScreen(1) }),
    c('feature/menu-screen', 'lerato', 52, 'Live stock badges on the menu', { 'src/screens/Menu.tsx': menuScreen(2), 'src/stock.ts': stock(1) }),
    c('feature/menu-screen', 'lerato', 50, 'Show "only a few left" under five', { 'src/screens/Menu.tsx': menuScreen(3) }),
    m('feature/menu-screen', 18, 'thabo', 49, 'Menu screen with live stock'),
    b('fix/stock-sync'),
    c('fix/stock-sync', 'sipho', 45, 'Refresh stock every 30 seconds', { 'src/stock.ts': stock(2) }),
    m('fix/stock-sync', 19, 'thabo', 44, 'Keep stock in sync with the counter'),
    b('feature/cart-checkout'),
    c('feature/cart-checkout', 'lerato', 30, 'Cart and checkout screens', { 'src/cart.ts': cart(1), 'src/screens/Checkout.tsx': checkout(1) }),
    c('main', 'thabo', 25, 'Payment provider decision: Yoco', { 'docs/decisions/001-payments.md': decision }),
    c('feature/cart-checkout', 'lerato', 20, 'Cart totals with VAT', { 'src/cart.ts': cart(2) }),
    b('feature/yoco-payments'),
    c('feature/yoco-payments', 'thabo', 12, 'Yoco checkout client', { 'src/payments/yoco.ts': yoco(1) }),
    c('feature/cart-checkout', 'lerato', 8, 'Fix checkout on small phones', { 'src/screens/Checkout.tsx': checkout(2), 'src/screens/checkout.css': checkoutCss }),
    c('feature/yoco-payments', 'thabo', 6, 'Handle declined and cancelled payments', { 'src/payments/yoco.ts': yoco(2) }),
    b('feature/barista-notifications'),
    c('feature/barista-notifications', 'sipho', 3, 'Order notifications: first sketch', { 'src/notifications.ts': notifications }),
    c('feature/cart-checkout', 'lerato', 1.4, 'Review fixes: round VAT once on the total', { 'src/cart.ts': cart(3) }),
    c('feature/yoco-payments', 'thabo', 0.6, 'Verify Yoco webhook signatures', { 'src/payments/webhook.ts': webhook }),
]

// ---- Tidepool Dive School: booking website ----

const tidepoolCalendar = (v: 1 | 2) => `export interface Dive { id: string; date: string; site: string; spaces: number; booked: number }

export function upcoming(dives: Dive[], today: string) {
    return dives.filter((d) => d.date >= today).sort((a, b) => a.date.localeCompare(b.date))
}
${v === 2 ? '\nexport const isSoldOut = (d: Dive) => d.booked >= d.spaces\n' : ''}`
const deposit = (v: 1 | 2) => `/** Divers pay a 30% deposit to hold a space. */
export const DEPOSIT_SHARE = 0.3

export const depositFor = (priceCents: number) => Math.round(priceCents * DEPOSIT_SHARE)
${v === 2 ? '\n/** Full refund up to 48 hours before the dive; after that the deposit is kept. */\nexport function refundFor(depositCents: number, hoursBefore: number) {\n    return hoursBefore >= 48 ? depositCents : 0\n}\n' : ''}`

const TIDEPOOL: Step[] = [
    c('main', 'thabo', 40, 'Booking site skeleton', { 'README.md': '# Tidepool bookings\n\nCourse and dive bookings for Tidepool Dive School, Sodwana Bay.\n', 'src/index.html': '<!doctype html>\n<title>Tidepool Dive School</title>\n<main id="app"></main>\n' }),
    b('feature/course-calendar'),
    c('feature/course-calendar', 'lerato', 35, 'Course calendar', { 'src/calendar.ts': tidepoolCalendar(1) }),
    c('feature/course-calendar', 'lerato', 33, 'Mark sold-out dives', { 'src/calendar.ts': tidepoolCalendar(2) }),
    m('feature/course-calendar', 7, 'thabo', 32, 'Course calendar'),
    b('deposit-payments'),
    c('deposit-payments', 'sipho', 20, 'Deposit payments', { 'src/deposit.ts': deposit(1) }),
    c('main', 'thabo', 10, 'Go-live checklist', { 'docs/go-live.md': '# Go-live\n\n- [ ] Domain and email\n- [ ] Deposit payments tested with a real card\n- [x] Calendar loaded with December dives\n' }),
    c('deposit-payments', 'sipho', 4, 'Deposit refunds', { 'src/deposit.ts': deposit(2) }),
]

// ---- Marula Health Clinic: patient booking portal ----

const MARULA: Step[] = [
    c('main', 'thabo', 16, 'Initial commit', { 'README.md': '# Marula patient portal\n' }),
    b('chore/skeleton'),
    c('chore/skeleton', 'thabo', 15, 'Project skeleton', { 'package.json': '{ "name": "marula-portal", "private": true }\n' }),
    c('chore/skeleton', 'thabo', 14.5, 'POPIA notes', { 'docs/popia.md': '# POPIA\n\nWe store the least we can: name, phone, appointment time.\nNo diagnosis or notes leave the clinic system.\n' }),
    m('chore/skeleton', 2, 'thabo', 14, 'Project skeleton and POPIA notes'),
    b('docs/popia-data-map'),
    c('docs/popia-data-map', 'thabo', 2, 'POPIA data map: first pass', { 'docs/data-map.md': '| Data | Where | Kept for |\n|---|---|---|\n| Name, phone | Bookings table | 2 years |\n| Appointment time | Bookings table | 2 years |\n' }),
]

export const DEMO_REPOS: Record<string, Step[]> = {
    'demo-studio/karoo-ordering': KAROO,
    'demo-studio/tidepool-booking': TIDEPOOL,
    'demo-studio/marula-portal': MARULA,
}

/** Builds the demo repos under root and returns their folders by repo name. Needs git. */
export async function makeDemoRepos(root: string, now = new Date()): Promise<Record<string, string>>
{
    const out: Record<string, string> = {}
    for (const [repo, steps] of Object.entries(DEMO_REPOS)) {
        const dir = join(root, repo.replace('/', '__'))
        await rm(dir, { recursive: true, force: true })
        await mkdir(dir, { recursive: true })
        const git = (args: string[], who?: Who, days?: number) => {
            const p = who ? PEOPLE[who] : PEOPLE.thabo
            const when = new Date(now.getTime() - (days ?? 0) * 86_400_000).toISOString()
            return exec('git', ['-C', dir, '-c', 'commit.gpgsign=false', '-c', 'init.defaultBranch=main', ...args], {
                env: { ...process.env, GIT_AUTHOR_NAME: p.name, GIT_AUTHOR_EMAIL: p.email, GIT_COMMITTER_NAME: p.name, GIT_COMMITTER_EMAIL: p.email, GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when },
            })
        }
        await git(['init', '--quiet', '--initial-branch=main'])
        let current = 'main'
        const checkout = async (name: string) => {
            if (current !== name) await git(['checkout', '--quiet', name])
            current = name
        }
        for (const step of steps) {
            if (step.kind === 'branch') {
                await checkout(step.from)
                await git(['branch', step.name])
            } else if (step.kind === 'commit') {
                await checkout(step.on)
                for (const [path, content] of Object.entries(step.files)) {
                    await mkdir(dirname(join(dir, path)), { recursive: true })
                    await writeFile(join(dir, path), content)
                }
                await git(['add', '-A'])
                await git(['commit', '--quiet', '-m', step.msg], step.who, step.days)
            } else {
                await checkout(step.into)
                await git(['merge', '--quiet', '--no-ff', '-m', step.msg, step.from], step.who, step.days)
                if (step.deleteBranch) await git(['branch', '-D', step.from])
            }
        }
        await checkout('main')
        out[repo] = dir
    }
    return out
}
