export interface Email {
  to: string
  subject: string
  text: string
  html: string
}

export interface Mailer {
  send: (email: Email) => Promise<void>
}

export class MailerError extends Error {}

interface CloudflareResponse {
  success: boolean
  errors?: { code: number, message: string }[]
}

/**
 * Sends through the Cloudflare Email Service REST API.
 * https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
 */
export class CloudflareMailer implements Mailer {
  private readonly options: { accountId: string, token: string, from: string }
  private readonly fetchImpl: typeof fetch

  constructor(options: { accountId: string, token: string, from: string }, fetchImpl: typeof fetch = fetch) {
    this.options = options
    this.fetchImpl = fetchImpl
  }

  async send(email: Email) {
    const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(this.options.accountId)}/email/sending/send`
    const response = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.options.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: this.options.from, ...email }),
    })
    const result = await response.json().catch(() => undefined) as CloudflareResponse | undefined
    if (!response.ok || !result?.success) {
      const reason = result?.errors?.map(error => `${error.code} ${error.message}`).join(', ') || `HTTP ${response.status}`
      throw new MailerError(`Cloudflare Email Service refused the email: ${reason}`)
    }
  }
}

/** Prints emails instead of sending them. For local development only. */
export class ConsoleMailer implements Mailer {
  async send(email: Email) {
    console.info(`\n--- Email to ${email.to}: ${email.subject}\n${email.text}\n---\n`)
  }
}
