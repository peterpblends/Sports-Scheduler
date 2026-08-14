import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

export type Mail = {
  to: string
  subject: string
  text: string
  html?: string
}

export interface Mailer {
  send(mail: Mail): Promise<void>
}

/**
 * Development / test transport. Writes each message to `.mail/` and logs the
 * subject plus any links so invitation and reset flows are exercisable without
 * an SMTP server. Phase 6 adds templates and preferences on top of this
 * interface.
 */
class ConsoleMailer implements Mailer {
  private counter = 0

  async send(mail: Mail): Promise<void> {
    const dir = join(process.cwd(), '.mail')
    // 0700: these files are live password-reset and invitation links. On a shared
    // host a world-readable directory of them is an account-takeover kit.
    await mkdir(dir, { recursive: true, mode: 0o700 })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    // The recipient is sanitised before it reaches a path: an address is
    // attacker-influenced (anyone can request a reset for any address they type) and
    // `../` in a filename is how that becomes a write outside `.mail/`.
    const name = `${stamp}-${String(++this.counter).padStart(3, '0')}-${mail.to.replace(/[^\w.@-]/g, '_')}.txt`
    const body = `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`
    // Owner-only. These files contain live password-reset and invitation links.
    await writeFile(join(dir, name), body, { encoding: 'utf8', mode: 0o600 })

    if (process.env.NODE_ENV === 'test') return

    console.log(`\n[mail] to=${mail.to} subject="${mail.subject}"`)

    // Links are the whole point of this transport in development — a reset flow is
    // untestable without them — and they are exactly what must never reach a
    // production log, because each one is a single-use credential that grants
    // account access. Printed only outside production.
    if (process.env.NODE_ENV === 'production') {
      console.log('[mail] link(s) withheld: set MAIL_TRANSPORT=smtp to deliver mail properly')
      return
    }
    for (const link of mail.text.match(/https?:\/\/\S+/g) ?? []) console.log(`[mail] link: ${link}`)
  }
}

class SmtpMailer implements Mailer {
  async send(mail: Mail): Promise<void> {
    const { createTransport } = await import('nodemailer')
    const transport = createTransport(process.env.SMTP_URL!)
    await transport.sendMail({
      from: process.env.MAIL_FROM ?? 'no-reply@example.com',
      to: mail.to,
      subject: mail.subject,
      text: mail.text,
      html: mail.html,
    })
  }
}

let instance: Mailer | null = null
let warned = false

export function mailer(): Mailer {
  if (!instance) {
    const smtp = process.env.MAIL_TRANSPORT === 'smtp' && process.env.SMTP_URL
    if (!smtp && process.env.NODE_ENV === 'production' && !warned) {
      warned = true
      // Loud, once. Running the file-writing transport in production means invitation
      // and reset links are landing on disk instead of in inboxes — the flows appear
      // to work while nobody can actually complete them, and the tokens accumulate
      // somewhere they were never meant to be.
      console.warn(
        '[mail] MAIL_TRANSPORT is not smtp in production. Messages will be written to .mail/ ' +
          'instead of delivered, and password-reset and invitation links will not reach anyone. ' +
          'Set MAIL_TRANSPORT=smtp and SMTP_URL.',
      )
    }
    instance = smtp ? new SmtpMailer() : new ConsoleMailer()
  }
  return instance
}

/** Test seam: swap in a capturing mailer. */
export function setMailer(m: Mailer | null): void {
  instance = m
}

export function appUrl(path = '/'): string {
  const base = (process.env.APP_URL ?? 'http://localhost:3000').replace(/\/$/, '')
  return `${base}${path.startsWith('/') ? path : `/${path}`}`
}
