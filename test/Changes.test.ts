import { describe, expect, it } from "vitest"

import { Sha } from "../src/Brands.ts"
import { changesSince, needsYou, snapshotOf } from "../src/Changes.ts"
import { item, pull } from "./fixtures.ts"

describe("changesSince", () => {
  it("records a baseline the first time it sees a pull request", () => {
    expect(changesSince(pull({ items: [item({ id: "a" })] }), undefined)).toEqual([])
  })

  it("reports only items it has not seen", () => {
    const before = snapshotOf(pull({ items: [item({ id: "a" })] }), undefined)
    const after = pull({ items: [item({ id: "a" }), item({ id: "b" })] })

    expect(changesSince(after, before).map((change) => (change.kind === "item" ? change.item.id : change.kind))).toEqual(["b"])
  })

  it("reports CI once it settles, and again for a new head", () => {
    const pending = snapshotOf(pull(), undefined)
    const failed = pull({ checks: "failed" })

    expect(changesSince(failed, pending)).toEqual([{ kind: "checks", checks: "failed", head: "abc1234def" }])
    expect(changesSince(failed, snapshotOf(failed, pending))).toEqual([])
    expect(changesSince(pull({ checks: "failed", head: "fff0000aaa" }), snapshotOf(failed, pending))).toHaveLength(1)
  })

  it("reports ready to merge once, and does not flap while GitHub has not computed mergeability", () => {
    const approved = pull({ decision: "APPROVED", checks: "passed" })
    const ready = snapshotOf(approved, snapshotOf(pull(), undefined))

    expect(ready.ready).toBe(true)
    expect(changesSince(pull({ decision: "APPROVED", checks: "passed", mergeable: "unknown" }), ready)).toEqual([])
    expect(changesSince(approved, { ...ready, ready: false })).toContainEqual({ kind: "ready" })
  })
})

describe("needsYou", () => {
  it("is true for people and for approval, false for bots and CI", () => {
    expect(needsYou({ kind: "item", item: item({ id: "a" }) })).toBe(true)
    expect(needsYou({ kind: "item", item: item({ id: "b", bot: true, author: "coderabbitai" }) })).toBe(false)
    expect(needsYou({ kind: "decision", decision: "APPROVED" })).toBe(true)
    expect(needsYou({ kind: "checks", checks: "failed", head: Sha.make("x") })).toBe(false)
  })
})
