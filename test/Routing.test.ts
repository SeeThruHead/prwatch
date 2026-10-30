import { Option } from "effect"
import { describe, expect, it } from "vitest"

import { evaluate, pullsNeeded, route, wanted } from "../src/Routing.ts"
import { host, me, merged, rule, run } from "./runs.ts"

const context = { viewer: me, pulls: [merged()] }

describe("wanted", () => {
  it("defaults to failed and succeeded, and lets completed stand for any finished outcome", () => {
    expect(wanted(rule(), "succeeded")).toBe(true)
    expect(wanted(rule(), "cancelled")).toBe(false)
    expect(wanted(rule(), "started")).toBe(false)
    expect(wanted(rule({ notify: { on: ["completed"] } }), "cancelled")).toBe(true)
    expect(wanted(rule({ notify: { on: ["completed"] } }), "started")).toBe(false)
    expect(wanted(rule({ notify: { on: ["started"] } }), "started")).toBe(true)
  })
})

describe("route", () => {
  it("takes the first rule that matches and links, and falls through one that matches without linking", () => {
    const stranger = rule({ name: "stranger", link: "actor" })
    const verdicts = evaluate(
      [stranger, rule({ name: "fallback", link: "any" })],
      run({ triggering_actor: { login: "other" } }),
      host,
      context
    )

    expect(Option.map(route(verdicts), (routed) => routed.rule.name)).toEqual(Option.some("fallback"))
  })

  it("routes nothing when no rule matches", () => {
    expect(Option.isNone(route(evaluate([rule({ repos: ["other/*"] })], run(), host, context)))).toBe(true)
  })
})

describe("pullsNeeded", () => {
  it("asks for the pull requests of a commit only when a matching rule links through them", () => {
    expect(pullsNeeded([rule({ link: "merge-commit" })], run(), host)).toBe(true)
    expect(pullsNeeded([rule({ link: "merge-commit", repos: ["other/*"] })], run(), host)).toBe(false)
    expect(pullsNeeded([rule({ link: "actor" })], run(), host)).toBe(false)
  })
})
