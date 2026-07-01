import jwt from 'jsonwebtoken'

export interface SupabaseJwtPayload {
  sub: string
  email?: string
}

export function verifySupabaseJwt(token: string): SupabaseJwtPayload {
  return jwt.verify(token, process.env.SUPABASE_JWT_SECRET!) as SupabaseJwtPayload
}
