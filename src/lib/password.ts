import { hash, verify } from '@node-rs/argon2'

// argon2id with parameters in the range OWASP suggests for interactive logins.
const OPTIONS = {
  memoryCost: 19456, // 19 MiB
  timeCost: 2,
  parallelism: 1,
}

export async function hashPassword(plain: string): Promise<string> {
  return hash(plain, OPTIONS)
}

export async function verifyPassword(storedHash: string, plain: string): Promise<boolean> {
  try {
    return await verify(storedHash, plain, OPTIONS)
  } catch {
    // A malformed hash must read as "wrong password", never as a crash.
    return false
  }
}

/** Cost-equivalent work performed on unknown-email logins so timing does not leak. */
export async function fakeVerify(): Promise<void> {
  await hashPassword('timing-equalizer')
}
