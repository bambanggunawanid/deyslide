import type { BetaUsage } from '@anthropic-ai/sdk/resources/beta/messages'
import type { AppDb } from '../db.ts'
import { sql } from 'kysely'

/** US dollars per million tokens. */
interface Price {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/**
 * Claude API list prices for the model the assistant asks for and the models
 * a server side fallback can hand a request to. Cache writes last 5 minutes.
 */
const PRICES: Record<string, Price> = {
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
}

/** A model missing from the table is counted at the highest Claude price, so the allowance never undercounts. */
const UNKNOWN_MODEL_PRICE: Price = { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 }

function priceOf(model: string | null | undefined): Price {
  const known = Object.keys(PRICES)
    .sort((a, b) => b.length - a.length)
    .find(name => model === name || model?.startsWith(`${name}-`))
  return known ? PRICES[known] : UNKNOWN_MODEL_PRICE
}

interface TokenCounts {
  input_tokens: number
  output_tokens: number
  cache_read_input_tokens?: number | null
  cache_creation_input_tokens?: number | null
}

function micros(price: Price, tokens: TokenCounts) {
  return tokens.input_tokens * price.input
    + tokens.output_tokens * price.output
    + (tokens.cache_read_input_tokens ?? 0) * price.cacheRead
    + (tokens.cache_creation_input_tokens ?? 0) * price.cacheWrite
}

/**
 * What one response cost, in millionths of a dollar, rounded up. When a
 * fallback ran, `iterations` has one entry per model attempt, each billed at
 * its own model's price. Otherwise the top level usage covers the response.
 */
export function costInMicros(model: string, usage: Pick<BetaUsage, 'input_tokens' | 'output_tokens' | 'cache_read_input_tokens' | 'cache_creation_input_tokens' | 'iterations'>) {
  const attempts = (usage.iterations ?? []).filter(entry => entry.type === 'message' || entry.type === 'fallback_message')
  const total = attempts.length > 0
    ? attempts.reduce((sum, entry) => sum + micros(priceOf(entry.model), entry), 0)
    : micros(priceOf(model), usage)
  return Math.ceil(total)
}

/** The calendar month an amount counts toward, in UTC, such as "2026-09". */
export function monthOf(date: Date) {
  return date.toISOString().slice(0, 7)
}

/** When the allowance of the month holding `date` starts again: the first day of the next month, in UTC. */
export function nextMonthStart(date: Date) {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + 1, 1))
}

/** How much each account spent on the assistant, per month. */
export class UsageStore {
  private readonly db: AppDb

  constructor(db: AppDb) {
    this.db = db
  }

  /** Millionths of a dollar spent in the month. */
  async spent(userId: string, month: string): Promise<number> {
    const row = await this.db.selectFrom('assistant_usage')
      .select('cost_micros')
      .where('user_id', '=', userId)
      .where('month', '=', month)
      .executeTakeFirst()
    return row?.cost_micros ?? 0
  }

  /** Adds to the month's total and returns the new total. */
  async add(userId: string, month: string, cost: number): Promise<number> {
    const row = await this.db.insertInto('assistant_usage')
      .values({ user_id: userId, month, cost_micros: cost })
      .onConflict(conflict => conflict.columns(['user_id', 'month']).doUpdateSet({
        cost_micros: sql<number>`assistant_usage.cost_micros + excluded.cost_micros`,
      }))
      .returning('cost_micros')
      .executeTakeFirstOrThrow()
    return row.cost_micros
  }
}
