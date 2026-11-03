// Checks the sandbox from inside the app container:
//   docker compose exec app node_modules/.bin/tsx apps/api/src/sandbox-check.ts
import { folderSandbox } from './sandbox.ts'

const sb = folderSandbox(process.env.SANDBOX_DIR ?? '/jobs', 15_000)
const cases: [string, string][] = [
    ['plain code runs', 'return input.split("\\n").length'],
    ['network is blocked', 'return fetch("https://example.com").then((r) => r.status)'],
    ['reading files is blocked', 'return process.getBuiltinModule("fs").readdirSync("/")'],
    ['starting processes is blocked', 'return process.getBuiltinModule("child_process").execSync("id").toString()'],
    ['endless loops are stopped', 'for (;;) {}'],
]
for (const [name, code] of cases) {
    try {
        console.log(`${name}: ran, returned ${JSON.stringify(await sb.run(code, 'a\nb'))}`)
    } catch (err) {
        console.log(`${name}: refused (${(err as Error).message.slice(0, 120)})`)
    }
}
