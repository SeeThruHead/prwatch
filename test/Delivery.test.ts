import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Exit, Layer, Schema } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { RulesConfig } from "../src/Config.ts"
import { DEFAULT_DELIVERY, planOf } from "../src/Delivery.ts"
import { WatchRules } from "../src/Rules.ts"

const configured = (files: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), "prwatch-delivery-"))
  Object.entries(files).forEach(([name, content]) => writeFileSync(join(dir, name), JSON.stringify(content)))

  return RulesConfig.layer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PRWATCH_CONFIG_DIR: dir, HOME: dir })))
  )
}

const deliveryOf = (files: Record<string, unknown>) =>
  Effect.gen(function* () {
    const config = yield* RulesConfig
    return yield* config.delivery
  }).pipe(Effect.provide(configured(files)))

describe("delivery order", () => {
  it("defaults to the multiplexers first and Claude's inbox socket last", () => {
    expect(planOf(DEFAULT_DELIVERY)).toEqual({ multiplexers: ["herdr", "cmux", "orca", "tmux"], socket: "last" })
  })

  it("follows a custom order of multiplexers", () => {
    expect(planOf(["orca", "herdr", "claude"])).toEqual({ multiplexers: ["orca", "herdr"], socket: "last" })
  })

  it("prefers the inbox socket when claude is listed before every multiplexer", () => {
    expect(planOf(["claude", "herdr"])).toEqual({ multiplexers: ["herdr"], socket: "first" })
  })

  it("leaves the inbox socket out when claude is not listed", () => {
    expect(planOf(["herdr", "cmux"])).toEqual({ multiplexers: ["herdr", "cmux"], socket: "off" })
    expect(planOf(["claude"])).toEqual({ multiplexers: [], socket: "first" })
  })

  it("decodes a delivery key beside the rules, and rules alone still decode", () => {
    expect(Schema.decodeSync(WatchRules)({ delivery: ["herdr", "claude"] })).toEqual({ rules: [], delivery: ["herdr", "claude"] })
    expect(Schema.decodeSync(WatchRules)({ rules: [] }).delivery).toBeUndefined()
  })

  it("rejects an unknown host name and an empty list", () => {
    expect(Exit.isFailure(Schema.decodeUnknownExit(WatchRules)({ delivery: ["herdr", "zellij"] }))).toBe(true)
    expect(Exit.isFailure(Schema.decodeUnknownExit(WatchRules)({ delivery: [] }))).toBe(true)
  })

  it.effect("reads the default when config.json has no delivery key or does not exist", () =>
    Effect.gen(function* () {
      const withoutFiles = yield* deliveryOf({})
      const withoutKey = yield* deliveryOf({ "config.json": { rules: [] } })

      expect(withoutFiles).toEqual(DEFAULT_DELIVERY)
      expect(withoutKey).toEqual(DEFAULT_DELIVERY)
    })
  )

  it.effect("reads the order from config.json, and config.local.json replaces it on one machine", () =>
    Effect.gen(function* () {
      const shared = yield* deliveryOf({ "config.json": { delivery: ["cmux", "herdr"] } })
      const local = yield* deliveryOf({
        "config.json": { delivery: ["cmux", "herdr"] },
        "config.local.json": { delivery: ["tmux", "claude"] }
      })

      expect(shared).toEqual(["cmux", "herdr"])
      expect(local).toEqual(["tmux", "claude"])
    })
  )

  it.effect("names the file, the position and the allowed hosts when a host is unknown", () =>
    Effect.gen(function* () {
      const error = yield* Effect.flip(deliveryOf({ "config.json": { delivery: ["herdr", "zellij"] } }))

      expect(error.message).toContain("config.json")
      expect(error.message).toContain('Expected "herdr" | "cmux" | "orca" | "tmux" | "claude"')
      expect(error.message).toContain('["delivery"][1]')
    })
  )
})
