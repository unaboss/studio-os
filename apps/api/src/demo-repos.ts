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
// A plain static site, so View shows the site itself as it was at any commit.

interface Site { hero?: boolean; courses?: boolean; calendar?: 0 | 1 | 2; deposit?: 0 | 1 | 2; footer?: boolean }

const tpHtml = (s: Site) => `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Tidepool Dive School · Sodwana Bay</title>
${s.hero ? '<link rel="stylesheet" href="styles.css">\n' : ''}</head>
<body>
${s.hero ? `<header class="top">
  <a class="logo" href="#">Tidepool<span>Dive School</span></a>
  <nav>${s.courses ? '<a href="#courses">Courses</a>' : ''}${s.calendar ? '<a href="#dives">Dives</a>' : ''}${s.deposit ? '<a class="cta" href="#book">Book a dive</a>' : ''}</nav>
</header>
<section class="hero">
  <p class="kicker">Sodwana Bay · iSimangaliso Wetland Park</p>
  <h1>Learn to dive on Africa's southernmost coral reefs.</h1>
  <p>Small groups, warm water and instructors who have logged thousands of dives on Two-Mile Reef.</p>
</section>` : `<h1>Tidepool Dive School</h1>
<p>Course and dive bookings, Sodwana Bay. Site coming soon.</p>`}
${s.courses ? `<section id="courses" class="band">
  <h2>Courses</h2>
  <div class="cards">
    <article><h3>Open Water</h3><p>Four days from first breath to 18 metres.</p><b>R6 900</b></article>
    <article><h3>Advanced</h3><p>Deep, night and navigation dives in two days.</p><b>R5 400</b></article>
    <article><h3>Nitrox</h3><p>Longer bottom times on the same reef.</p><b>R2 300</b></article>
  </div>
</section>
` : ''}${s.calendar ? `<section id="dives" class="band alt">
  <h2>Upcoming dives</h2>
  <ul id="dive-list" class="dives"></ul>
</section>
` : ''}${s.deposit ? `<section id="book" class="band">
  <h2>Book a dive</h2>
  <form id="book-form" class="book">
    <label>Course <select id="course"><option value="690000">Open Water · R6 900</option><option value="540000">Advanced · R5 400</option><option value="230000">Nitrox · R2 300</option></select></label>
    <label>Name <input required placeholder="Your name"></label>
    <p class="deposit">Deposit today (30%): <b id="deposit-amount">R2 070</b></p>
${s.deposit === 2 ? '    <p class="small">Full refund of your deposit up to 48 hours before the dive.</p>\n' : ''}    <button>Pay deposit</button>
  </form>
</section>
` : ''}${s.footer ? `<footer>
  <div><b>Tidepool Dive School</b><br>Jesser Point Road, Sodwana Bay</div>
  <div>hello@tidepool.example · 035 571 0000</div>
</footer>
` : ''}${s.calendar || s.deposit ? '<script src="app.js"></script>\n' : ''}</body>
</html>
`

const tpJs = (s: Site) => `${s.calendar ? `const dives = [
  { date: 'Sat 6 Dec', site: 'Two-Mile Reef', spaces: 8, booked: 8 },
  { date: 'Sun 7 Dec', site: 'Seven-Mile Reef', spaces: 8, booked: 5 },
  { date: 'Sat 13 Dec', site: 'Two-Mile Reef', spaces: 10, booked: 3 },
  { date: 'Sun 14 Dec', site: 'Quarter-Mile Reef', spaces: 6, booked: 1 },
]
const list = document.getElementById('dive-list')
for (const d of dives) {
  const li = document.createElement('li')
${s.calendar === 2 ? `  const soldOut = d.booked >= d.spaces
  li.className = soldOut ? 'sold' : ''
  li.innerHTML = '<b>' + d.date + '</b><span>' + d.site + '</span><em>' + (soldOut ? 'Sold out' : (d.spaces - d.booked) + ' spaces left') + '</em>'` : `  li.innerHTML = '<b>' + d.date + '</b><span>' + d.site + '</span><em>' + (d.spaces - d.booked) + ' of ' + d.spaces + ' spaces</em>'`}
  list.appendChild(li)
}
` : ''}${s.deposit ? `
const rand = (cents) => 'R' + Math.round(cents / 100).toLocaleString('en-ZA')
const course = document.getElementById('course')
const show = () => { document.getElementById('deposit-amount').textContent = rand(Number(course.value) * 0.3) }
course.addEventListener('change', show)
document.getElementById('book-form').addEventListener('submit', (e) => { e.preventDefault(); alert('Deposit paid. See you in Sodwana!') })
show()
` : ''}`

const tpCss = `:root { --sea: #0b4f6c; --deep: #072f42; --sand: #f6f1e7; --coral: #e8735a; --ink: #13232b; }
* { box-sizing: border-box; }
body { margin: 0; font: 16px/1.55 system-ui, -apple-system, 'Segoe UI', sans-serif; color: var(--ink); background: var(--sand); }
.top { display: flex; justify-content: space-between; align-items: center; padding: 18px 6vw; background: var(--deep); color: #fff; }
.logo { color: #fff; text-decoration: none; font-weight: 700; font-size: 20px; letter-spacing: -0.3px; }
.logo span { font-weight: 400; opacity: 0.7; margin-left: 6px; }
nav a { color: #d5e8ef; text-decoration: none; margin-left: 22px; font-size: 15px; }
nav a.cta { background: var(--coral); color: #fff; padding: 8px 16px; border-radius: 999px; }
.hero { padding: 84px 6vw 96px; color: #fff; background: radial-gradient(1200px 500px at 80% 120%, #1d8fb0 0%, transparent 60%), linear-gradient(160deg, var(--deep), var(--sea)); }
.hero h1 { font-size: clamp(32px, 5vw, 56px); line-height: 1.05; max-width: 720px; margin: 8px 0 16px; letter-spacing: -1px; }
.hero p { max-width: 560px; color: #cfe4ec; font-size: 18px; }
.kicker { text-transform: uppercase; letter-spacing: 2px; font-size: 13px !important; color: #8fd0e4 !important; }
.band { padding: 56px 6vw; }
.band.alt { background: #fff; }
h2 { font-size: 28px; margin: 0 0 24px; letter-spacing: -0.4px; }
.cards { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 18px; }
.cards article { background: #fff; border-radius: 14px; padding: 22px; box-shadow: 0 1px 0 rgba(0,0,0,.04), 0 10px 30px rgba(7,47,66,.08); }
.cards h3 { margin: 0 0 6px; color: var(--sea); }
.cards b { display: block; margin-top: 12px; font-size: 20px; }
.dives { list-style: none; padding: 0; margin: 0; display: grid; gap: 10px; max-width: 720px; }
.dives li { display: grid; grid-template-columns: 120px 1fr auto; gap: 12px; padding: 14px 18px; border: 1px solid #e3ddd0; border-radius: 12px; background: var(--sand); }
.dives em { font-style: normal; color: var(--sea); font-weight: 600; }
.dives li.sold { opacity: 0.55; }
.dives li.sold em { color: var(--coral); }
.book { display: grid; gap: 14px; max-width: 420px; background: #fff; padding: 24px; border-radius: 14px; box-shadow: 0 10px 30px rgba(7,47,66,.08); }
.book label { display: grid; gap: 6px; font-size: 14px; font-weight: 600; }
.book input, .book select { font: inherit; padding: 10px 12px; border: 1px solid #d8d2c4; border-radius: 10px; }
.book button { font: inherit; font-weight: 700; padding: 12px; border: 0; border-radius: 999px; background: var(--coral); color: #fff; cursor: pointer; }
.deposit { margin: 0; }
.small { font-size: 13px; color: #5b6b72; margin: 0; }
footer { display: flex; justify-content: space-between; gap: 24px; flex-wrap: wrap; padding: 36px 6vw; background: var(--deep); color: #cfe4ec; font-size: 14px; }
`

const TIDEPOOL: Step[] = [
    c('main', 'thabo', 40, 'Booking site skeleton', { 'README.md': '# Tidepool bookings\n\nThe website for Tidepool Dive School, Sodwana Bay. Plain HTML, CSS and JavaScript: open index.html.\n', 'index.html': tpHtml({}) }),
    c('main', 'thabo', 38, 'Hero, brand colours and type', { 'index.html': tpHtml({ hero: true }), 'styles.css': tpCss }),
    b('feature/course-calendar'),
    c('feature/course-calendar', 'lerato', 35, 'Course calendar', { 'index.html': tpHtml({ hero: true, calendar: 1 }), 'app.js': tpJs({ calendar: 1 }) }),
    c('feature/course-calendar', 'lerato', 33, 'Mark sold-out dives', { 'app.js': tpJs({ calendar: 2 }) }),
    m('feature/course-calendar', 7, 'thabo', 32, 'Course calendar'),
    c('main', 'lerato', 26, 'Course cards with prices', { 'index.html': tpHtml({ hero: true, courses: true, calendar: 2 }) }),
    b('deposit-payments'),
    c('deposit-payments', 'sipho', 20, 'Deposit payments', { 'index.html': tpHtml({ hero: true, courses: true, calendar: 2, deposit: 1 }), 'app.js': tpJs({ calendar: 2, deposit: 1 }) }),
    c('main', 'thabo', 10, 'Go-live checklist', { 'docs/go-live.md': '# Go-live\n\n- [ ] Domain and email\n- [ ] Deposit payments tested with a real card\n- [x] Calendar loaded with December dives\n' }),
    c('main', 'thabo', 6, 'Footer with address and contact', { 'index.html': tpHtml({ hero: true, courses: true, calendar: 2, footer: true }) }),
    c('deposit-payments', 'sipho', 4, 'Deposit refunds', { 'index.html': tpHtml({ hero: true, courses: true, calendar: 2, deposit: 2 }) }),
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
