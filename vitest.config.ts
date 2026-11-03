import { defineConfig } from 'vitest/config'

export default defineConfig({
    test: {
        include: ['packages/*/test/**/*.test.ts', 'modules/*/test/**/*.test.ts', 'apps/*/test/**/*.test.ts'],
        testTimeout: 20000,
    },
})
