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
    await mkdir(dir, { recursive: true })
    const stamp = new Date().toISOString().replace(/[:.]/g, '-')
    const name = `${stamp}-${String(++this.counter).padStart(3, '0')}-${mail.to.replace(/[^\w.@-]/g, '_')}.txt`
    const body = `To: ${mail.to}\nSubject: ${mail.subject}\n\n${mail.text}\n`
    await writeFile(join(dir, name), body, 'utf8')
    if (process.env.NODE_ENV !== 'test') {
      console.log(`\n[mail] to=${mail.to} subject="${mail.subject}"`)
      for (const link of mail.text.match(/https?:\/\/\S+/g) ?? []) console.log(`[mail] link: ${link}`)
    }
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

export function mailer(): Mailer {
  if (!instance) {
    instance =
      process.env.MAIL_TRANSPORT === 'smtp' && process.env.SMTP_URL ? new SmtpMailer() : new ConsoleMailer()
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
