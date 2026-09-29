import type { Auth } from '../auth.ts'
import type { ProjectStore } from '../projects.ts'
import type { Env } from '../routes.ts'
import type { AssistantEvent, StopReason } from './agent.ts'
import type { AssistantModel } from './model.ts'
import type { UsageStore } from './usage.ts'
import { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import { z } from 'zod'
import { atLeast } from '../projects.ts'
import { BadRequest, body, notFound, signedInOnly } from '../routes.ts'
import { runAssistant } from './agent.ts'
import { MARKDOWN_MAX_LENGTH } from './draft.ts'
import { costInMicros, monthOf, nextMonthStart } from './usage.ts'

export const MESSAGE_MAX_LENGTH = 4000
const HISTORY_MAX_MESSAGES = 20
const KEEP_ALIVE_MS = 15_000

const AssistantBody = z.object({
  markdown: z.string().max(MARKDOWN_MAX_LENGTH, `The assistant can work on decks up to ${MARKDOWN_MAX_LENGTH} characters`),
  message: z.string().trim().min(1, 'Write a message first').max(MESSAGE_MAX_LENGTH, `A message can have at most ${MESSAGE_MAX_LENGTH} characters`),
  history: z.array(z.object({
    role: z.enum(['user', 'assistant']),
    text: z.string().max(2 * MESSAGE_MAX_LENGTH),
  })).max(HISTORY_MAX_MESSAGES).default([]),
})

/** The allowance as the web app shows it. */
export interface AssistantAllowance {
  /** Share of this month's allowance used, from 0 to 100. */
  usedPercent: number
  /** When the allowance starts again, as an ISO date. */
  resetsAt: string
}

/** What ends the stream. The reply is the full text, which replaces what streamed. */
export interface AssistantDone {
  reply: string
  stop: StopReason
  allowance: AssistantAllowance
}

export interface AssistantDependencies {
  auth: Auth
  projects: ProjectStore
  usage: UsageStore
  model: AssistantModel
  monthlyLimitUsd: number
  now?: () => Date
}

const MONTH_NAMES = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December']

/** Such as "October 1". */
function dayName(date: Date) {
  return `${MONTH_NAMES[date.getUTCMonth()]} ${date.getUTCDate()}`
}

/**
 * The deck assistant, under /api. A request carries the open deck's Markdown
 * and streams back Server Sent Events: `text` pieces, `deck` changes, then
 * `done` or `failed`.
 */
export function assistantRoutes({ auth, projects, usage, model, monthlyLimitUsd, now = () => new Date() }: AssistantDependencies) {
  const limit = Math.round(monthlyLimitUsd * 1_000_000)
  /** Accounts with a request running. One at a time keeps the allowance check honest. */
  const running = new Set<string>()

  const allowance = (spent: number, date: Date): AssistantAllowance => ({
    usedPercent: Math.min(100, Math.floor(spent / limit * 100)),
    resetsAt: nextMonthStart(date).toISOString(),
  })

  const signedIn = signedInOnly(auth)
  const api = new Hono<Env>()

  api.onError((error, c) => {
    if (error instanceof BadRequest)
      return c.json({ error: error.message }, 400)
    throw error
  })

  api.get('/assistant', signedIn, async (c) => {
    const date = now()
    return c.json(allowance(await usage.spent(c.var.userId, monthOf(date)), date))
  })

  api.post('/decks/:id/assistant', signedIn, async (c) => {
    const userId = c.var.userId
    const request = await body(c, AssistantBody)
    const access = await projects.deckAccess(userId, c.req.param('id'))
    if (!access)
      return notFound(c)
    if (!atLeast(access.role, 'editor'))
      return c.json({ error: 'You can view this deck but not change it, so the assistant cannot work on it.' }, 403)

    const date = now()
    const month = monthOf(date)
    const spentBefore = await usage.spent(userId, month)
    if (spentBefore >= limit)
      return c.json({ error: `You have used this month's assistant allowance. It starts again on ${dayName(nextMonthStart(date))}.` }, 429)
    if (running.has(userId))
      return c.json({ error: 'The assistant is still working on your last message.' }, 409)
    running.add(userId)

    // Tells nginx to pass each event on at once instead of buffering the response.
    c.header('X-Accel-Buffering', 'no')
    return streamSSE(c, async (stream) => {
      // Events go out one after another, in the order they happened. A write to
      // a closed connection is dropped; the abort below stops the work.
      let queue = Promise.resolve()
      const write = (text: () => Promise<unknown>) => {
        queue = queue.then(text).then(() => {}, () => {})
        return queue
      }
      const controller = new AbortController()
      // Claude can think for a while without output. A comment every few seconds
      // keeps nginx and the Cloudflare tunnel from closing a quiet connection.
      const keepAlive = setInterval(() => {
        void write(() => stream.write(': keep alive\n\n'))
      }, KEEP_ALIVE_MS)
      stream.onAbort(() => controller.abort())
      const send = (event: string, data: unknown) => write(() => stream.writeSSE({ event, data: JSON.stringify(data) }))
      let spent = spentBefore
      try {
        const result = await runAssistant({
          model,
          request,
          userId,
          signal: controller.signal,
          emit: (event: AssistantEvent) => send(event.type, event),
          charge: async (turn) => {
            spent = await usage.add(userId, month, costInMicros(turn.model, turn.usage))
            return spent < limit
          },
        })
        await send('done', { ...result, allowance: allowance(spent, date) } satisfies AssistantDone)
      }
      catch (error) {
        console.error('The assistant failed', error)
        await send('failed', { error: 'The assistant could not finish. Try again in a moment.' })
      }
      finally {
        clearInterval(keepAlive)
        running.delete(userId)
        await queue
      }
    })
  })

  return api
}
