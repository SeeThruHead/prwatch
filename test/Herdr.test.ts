import { describe, expect, it } from "vitest"

import { Text } from "../src/Brands.ts"
import { notifyArgs } from "../src/hosts/Herdr.ts"

describe("herdr notifications", () => {
  it("passes the configured sound to herdr", () => {
    expect(notifyArgs(Text.make("title"), Text.make("body"), "none")).toEqual([
      "notification",
      "show",
      "title",
      "--body",
      "body",
      "--sound",
      "none"
    ])
    expect(notifyArgs(Text.make("title"), Text.make("body"), "request").at(-1)).toBe("request")
  })
})
