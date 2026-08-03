import { createResource } from "solid-js"

/** Shape of the desktop `user.get` payload (mapped from packages/desktop macOS identity). */
export interface DesktopUser {
  id: string
  email: string
  displayName: string | null
  tenantId: string | null
  isAdmin: boolean
  balance: number
}

/**
 * Loads the logged-in Microsoft user exactly once, on mount. In the web app
 * `window.api` is undefined, so the resource resolves to `null` and the caller
 * renders nothing. Optional chaining keeps this safe for every environment.
 */
export function useDesktopUser(): { user: () => DesktopUser | null } {
  const [user] = createResource(
    () => "boot",
    () => window.api?.user?.get?.() ?? Promise.resolve(null),
  )
  return { user: () => user() ?? null }
}

/**
 * First letters of up to two words, uppercased — used for the rail avatar.
 * Splits on whitespace so accented names (e.g. "María López") keep their
 * correct initials, and falls back to the email local part for addresses.
 */
export function userInitials(source: string | null): string {
  const raw = (source ?? "").trim()
  if (!raw) return ""
  const parts = raw.split(/[\s]+/).filter(Boolean)
  if (parts.length === 1 && parts[0]!.includes("@")) {
    const local = parts[0]!.split("@")[0]!
    return local.split(/[^a-zA-Z0-9]+/).filter(Boolean).slice(0, 2).map((word) => word[0]?.toUpperCase() ?? "").join("")
  }
  return parts
    .slice(0, 2)
    .map((word) => word[0]?.toUpperCase() ?? "")
    .join("")
}