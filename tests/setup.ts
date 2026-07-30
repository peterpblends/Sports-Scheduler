import { config as loadEnv } from 'dotenv'

loadEnv({ path: '.env', quiet: true })

if (!process.env.TEST_DATABASE_URL) {
  throw new Error('TEST_DATABASE_URL must be set to run the test suite. See .env.example.')
}

// Must happen before anything imports src/lib/prisma.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL
// Vitest already sets NODE_ENV=test; assert it rather than reassigning the
// read-only property.
if (process.env.NODE_ENV !== 'test') {
  throw new Error(`Expected NODE_ENV=test, got ${process.env.NODE_ENV}`)
}
process.env.APP_URL = 'http://localhost:3000'
process.env.MAIL_TRANSPORT = 'console'
process.env.SESSION_TTL_DAYS = '30'
