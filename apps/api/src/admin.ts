// Command line jobs for the server owner.
//
//   npm run admin -- create-company "North Tech Africa" you@company.co.za "Your Name" 'a long password'
//   npm run admin -- reset-demo
//
// On the VM: docker compose exec app npm run admin -- create-company ...
import { DEFAULT_CONFIG, newId } from '@studio-os/core'
import { hashPassword } from './auth.ts'
import { seedDemo } from './seed.ts'
import { connect } from './server.ts'

const [command, ...args] = process.argv.slice(2)
const { db, close } = await connect()

try {
    if (command === 'create-company') {
        const [name, email, person, password] = args
        if (!name || !email || !person || !password || password.length < 10) {
            throw new Error('Usage: create-company "<company>" <email> "<your name>" "<password, 10+ characters>"')
        }
        const companyId = newId('co')
        const config = { ...DEFAULT_CONFIG, theme: { ...DEFAULT_CONFIG.theme, name } }
        await db.query('insert into companies (id, name, config) values ($1, $2, $3::jsonb)', [companyId, name, JSON.stringify(config)])
        await db.query(
            'insert into users (id, company_id, email, name, role, password_hash) values ($1, $2, $3, $4, $5, $6)',
            [newId('usr'), companyId, email.toLowerCase(), person, 'manager', await hashPassword(password)],
        )
        console.log(`Created ${name} (${companyId}). Sign in as ${email}.`)
        console.log(`GitHub webhook URL for its repos: https://<your domain>/api/github/webhook?company=${companyId}`)
    } else if (command === 'reset-demo') {
        await seedDemo(db, { reset: true })
        console.log('Demo studio reset.')
    } else {
        console.log('Commands: create-company, reset-demo')
    }
} finally {
    await close()
}
