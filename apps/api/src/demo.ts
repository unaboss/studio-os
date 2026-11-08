// The demo studio on any computer, Windows included: `npm run demo`, then open
// http://localhost:3000. Postgres runs in-process and the demo repos are built
// with git, so the only things to install are Node 22 and git.
import { randomBytes } from 'node:crypto'

process.env.DATABASE_URL ??= 'pglite:'
process.env.SESSION_SECRET ??= randomBytes(32).toString('hex')
process.env.SEED_DEMO ??= '1'
process.env.DEMO ??= '1'
process.env.COOKIE_SECURE ??= '0'
process.env.SCHEDULER ??= '0'
process.env.PORT ??= '3000'

const { main } = await import('./server.ts')
await main()
