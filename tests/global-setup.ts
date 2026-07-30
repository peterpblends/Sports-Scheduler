import { execSync } from 'node:child_process'
import { config as loadEnv } from 'dotenv'

/**
 * Points the whole test run at TEST_DATABASE_URL and brings its schema up to
 * date once, before any test file is imported.
 */
export default function setup() {
  loadEnv({ path: '.env', quiet: true })

  const url = process.env.TEST_DATABASE_URL
  if (!url) {
    throw new Error('TEST_DATABASE_URL must be set to run the test suite. See .env.example.')
  }

  execSync('npx prisma migrate deploy', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  })
}
