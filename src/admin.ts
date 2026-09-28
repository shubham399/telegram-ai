/**
 * Admin authorisation.
 *
 * Single-responsibility: answer "is this user an admin?", from one place, so the
 * tool loader and any future admin surface cannot drift apart.
 *
 * Deny by default. With no ADMIN_USER_IDS configured, nobody is an admin and
 * every `adminOnly` tool is invisible to everyone — including the owner. That is
 * the safe failure direction: a misconfigured env hides a tool, it never exposes
 * a shell to the public.
 */
import { ADMIN_USER_IDS } from './config'

export function isAdmin(userId: string): boolean {
  return ADMIN_USER_IDS.has(userId)
}
