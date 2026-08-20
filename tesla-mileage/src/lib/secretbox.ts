/**
 * Encryption for the one genuinely sensitive thing the app stores: the Tesla
 * refresh token, which is a long-lived key to someone's car.
 *
 * The key comes from MILE_LEDGER_SECRET in the environment. That matters: a key
 * kept in the same database it protects buys nothing, so when no environment
 * secret is configured the token is stored as-is and the app says so rather than
 * pretending. Anything already stored in plaintext keeps working.
 */
import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';

const PREFIX = 'enc.v1.';
const SALT = 'mile-ledger.token.v1';

function keyFrom(secret: string): Buffer {
  return scryptSync(secret, SALT, 32);
}

export function isEncrypted(value: string): boolean {
  return value.startsWith(PREFIX);
}

/** Encrypt with AES-256-GCM. Returns the value unchanged if there is no key. */
export function seal(plaintext: string, secret: string): string {
  if (secret === '') return plaintext;
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyFrom(secret), iv);
  const body = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${PREFIX}${iv.toString('base64url')}.${body.toString('base64url')}.${tag.toString('base64url')}`;
}

/**
 * Decrypt a sealed value. Plaintext is passed through, so a database written
 * before a secret was configured still opens.
 */
export function open(value: string, secret: string): string | null {
  if (!isEncrypted(value)) return value;
  if (secret === '') return null;
  const [ivPart, bodyPart, tagPart] = value.slice(PREFIX.length).split('.');
  if (ivPart === undefined || bodyPart === undefined || tagPart === undefined) return null;
  try {
    const decipher = createDecipheriv(
      'aes-256-gcm',
      keyFrom(secret),
      Buffer.from(ivPart, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagPart, 'base64url'));
    return Buffer.concat([
      decipher.update(Buffer.from(bodyPart, 'base64url')),
      decipher.final(),
    ]).toString('utf8');
  } catch {
    // Wrong key, or the value was tampered with. Either way it is not usable.
    return null;
  }
}
