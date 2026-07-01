import { createClient } from '@supabase/supabase-js'

const GATEWAY_URL = process.env.GATEWAY_URL ?? 'http://localhost:3000'
const TEST_EMAIL = 'test@ourcelium.dev'
const TEST_PASSWORD = 'Test1234!'

// Admin client bypasses email confirmation
const admin = createClient(
  process.env.SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } }
)

// Create test user (email_confirm: true skips confirmation email)
const { error: createError } = await admin.auth.admin.createUser({
  email: TEST_EMAIL,
  password: TEST_PASSWORD,
  email_confirm: true,
})
if (createError && !createError.message.includes('already been registered')) {
  throw createError
}

// Sign in to get a real JWT
const anon = createClient(process.env.SUPABASE_URL!, process.env.SUPABASE_ANON_KEY!)
const { data: { session }, error: signInError } = await anon.auth.signInWithPassword({
  email: TEST_EMAIL,
  password: TEST_PASSWORD,
})
if (signInError) throw signInError

// Call /v1/keys on the local gateway
const res = await fetch(`${GATEWAY_URL}/v1/keys`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${session!.access_token}` },
})
const body = await res.json() as { key?: string; error?: string }
if (!body.key) throw new Error(`/v1/keys failed: ${JSON.stringify(body)}`)

console.log('API key:', body.key)
console.log()
console.log('Smoke test:')
console.log(`curl -N "${GATEWAY_URL}/v1/chat/completions" \\
  -H "Authorization: Bearer ${body.key}" \\
  -H "Content-Type: application/json" \\
  -d '{"messages":[{"role":"user","content":"Say hello in one word."}]}'`)
