/**
 * security — credential primitives.
 *
 * Token generation, constant-time comparison, and cookie parsing. HTML
 * escaping lives in http-util.js (it is output plumbing, not a secret).
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

const TOKEN_BYTES = 24

/** Generate a URL-safe access token with enough entropy for public tunnels. */
export function generateAccessToken() {
  return randomBytes(TOKEN_BYTES).toString('base64url')
}

/** Compare secrets without leaking a useful length or prefix timing signal. */
export function safeEqual(actual: string, expected: string) {
  const left = Buffer.from(String(actual))
  const right = Buffer.from(String(expected))
  if (left.length !== right.length) {
    timingSafeEqual(createHash('sha256').update(left).digest(), createHash('sha256').update(right).digest())
    return false
  }
  return timingSafeEqual(left, right)
}

/** Shortest custom token accepted: long enough that a LAN guest cannot guess it in a lunch break. */
export const MIN_ACCESS_TOKEN_LENGTH = 8
/** Longest custom token accepted: keeps the login form and the state file sane. */
export const MAX_ACCESS_TOKEN_LENGTH = 128

/**
 * Why a user-supplied token was rejected. `undefined` means it is acceptable.
 *
 * The rules are deliberately shape-agnostic — letters, digits and punctuation
 * are all welcome, so an owner can pick a passphrase they can retype on a phone
 * keyboard. What is enforced is length plus printable-ASCII-only: whitespace
 * and non-ASCII would be silently mangled by cookie/header handling before the
 * constant-time comparison ever runs, which turns a "wrong" token into a
 * mysterious 401 instead of an up-front validation error.
 */
export type AccessTokenProblem = 'empty' | 'too-short' | 'too-long' | 'invalid-chars'

export function validateAccessToken(value: unknown): AccessTokenProblem | undefined {
  if (typeof value !== 'string') return 'empty'
  const token = value
  if (token.length === 0) return 'empty'
  if (token.length < MIN_ACCESS_TOKEN_LENGTH) return 'too-short'
  if (token.length > MAX_ACCESS_TOKEN_LENGTH) return 'too-long'
  // 0x21-0x7e: printable ASCII, no space, no control characters.
  if (!/^[\x21-\x7E]+$/.test(token)) return 'invalid-chars'
  return undefined
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {}
  for (const field of String(header ?? '').split(';')) {
    const at = field.indexOf('=')
    if (at < 1) continue
    const key = field.slice(0, at).trim()
    const value = field.slice(at + 1).trim()
    if (key.length > 0) cookies[key] = value
  }
  return cookies
}

