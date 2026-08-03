import { describe, expect, test } from "bun:test"
import { userInitials } from "./sidebar-user"

describe("userInitials", () => {
  test("keeps accented names intact (Spanish/Latin names)", () => {
    expect(userInitials("María López")).toBe("ML")
    expect(userInitials("José Fernández")).toBe("JF")
    expect(userInitials("Iván")).toBe("I")
  })

  test("uses the email local part for addresses", () => {
    expect(userInitials("ivan.Fernandez@oneinfoconsulting.com")).toBe("IF")
    expect(userInitials("maria@example.com")).toBe("M")
  })

  test("handles empty and null sources", () => {
    expect(userInitials(null)).toBe("")
    expect(userInitials("")).toBe("")
    expect(userInitials("   ")).toBe("")
  })
})
