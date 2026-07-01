import {
  pgTable,
  serial,
  text,
  bigint,
  boolean,
  timestamp,
  smallint,
  unique,
} from 'drizzle-orm/pg-core'

export const users = pgTable('users', {
  id: serial('id').primaryKey(),
  supabaseUserId: text('supabase_user_id').notNull().unique(),
  email: text('email').notNull(),
  creditsTokens: bigint('credits_tokens', { mode: 'number' }).notNull().default(0),
  isAdmin: boolean('is_admin').notNull().default(false),
  stripeCustomerId: text('stripe_customer_id'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const apiKeys = pgTable('api_keys', {
  id: serial('id').primaryKey(),
  userId: serial('user_id').notNull().references(() => users.id),
  keyHash: text('key_hash').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at'),
}, (t) => [unique().on(t.userId)])

export const subscriptions = pgTable('subscriptions', {
  id: serial('id').primaryKey(),
  userId: serial('user_id').notNull().references(() => users.id),
  stripeCustomerId: text('stripe_customer_id'),
  stripeSubId: text('stripe_sub_id'),
  tier: text('tier', { enum: ['free', 'paid'] }).notNull().default('free'),
  periodStart: timestamp('period_start').notNull(),
  periodEnd: timestamp('period_end').notNull(),
  periodResetAnchor: smallint('period_reset_anchor'),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})

export const usageEvents = pgTable('usage_events', {
  id: serial('id').primaryKey(),
  userId: serial('user_id').notNull().references(() => users.id),
  inputTokens: bigint('input_tokens', { mode: 'number' }).notNull().default(0),
  outputTokens: bigint('output_tokens', { mode: 'number' }).notNull().default(0),
  model: text('model').notNull(),
  createdAt: timestamp('created_at').notNull().defaultNow(),
})
