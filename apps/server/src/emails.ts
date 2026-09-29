import type { Email } from './mailer.ts'

function escapeHtml(value: string) {
  return value.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

/** A short email with one call to action. Every email has a plain text part. */
function actionEmail(to: string, subject: string, intro: string, action: string, url: string, outro: string): Email {
  const text = `${intro}\n\n${action}: ${url}\n\n${outro}\n\nDeyslide`
  const html = `<!doctype html>
<html>
  <body style="margin:0;padding:24px;background:#0b1020;color:#e2e8f0;font-family:system-ui,sans-serif">
    <div style="max-width:480px;margin:0 auto">
      <p style="font-size:20px;font-weight:600;color:#38bdf8;margin:0 0 16px">Deyslide</p>
      <p style="margin:0 0 20px;line-height:1.5">${escapeHtml(intro)}</p>
      <p style="margin:0 0 20px">
        <a href="${escapeHtml(url)}" style="display:inline-block;padding:10px 16px;border-radius:6px;background:#38bdf8;color:#0b1020;text-decoration:none;font-weight:600">${escapeHtml(action)}</a>
      </p>
      <p style="margin:0;color:#94a3b8;font-size:14px;line-height:1.5">${escapeHtml(outro)}</p>
    </div>
  </body>
</html>`
  return { to, subject, text, html }
}

const IGNORE = 'If you did not ask for this, you can ignore this email.'

export function verificationEmail(to: string, url: string): Email {
  return actionEmail(to, 'Confirm your Deyslide email', 'Confirm this address to finish creating your Deyslide account.', 'Confirm email', url, IGNORE)
}

export function magicLinkEmail(to: string, url: string): Email {
  return actionEmail(to, 'Your Deyslide sign in link', 'Use this link to sign in to Deyslide. It works once and expires in 10 minutes.', 'Sign in', url, IGNORE)
}

export function resetPasswordEmail(to: string, url: string): Email {
  return actionEmail(to, 'Reset your Deyslide password', 'Use this link to choose a new password for Deyslide. It expires in 1 hour.', 'Reset password', url, IGNORE)
}
