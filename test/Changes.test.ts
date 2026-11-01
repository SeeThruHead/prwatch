import { describe, expect, it } from "vitest"

import { IsoTime, NodeId, Sha, Text } from "../src/Brands.ts"
import { anyNeedsYou, changesSince, isLifecycle, needsYou, snapshotOf } from "../src/Changes.ts"
import type { Lifecycle } from "../src/GitHub.ts"
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

const queued: Lifecycle = { id: NodeId.make("q1"), kind: "queued", at: IsoTime.make("2026-01-01T00:00:00Z") }
const kicked: Lifecycle = {
  id: NodeId.make("r1"),
  kind: "unqueued",
  at: IsoTime.make("2026-01-01T00:10:00Z"),
  reason: Text.make("failed_checks")
}
const merged: Lifecycle = { id: NodeId.make("m1"), kind: "merged", at: IsoTime.make("2026-01-01T01:00:00Z"), commit: Sha.make("a0f6b93") }

describe("lifecycle changes", () => {
  it("reports a queue entry, a kick and the merge once each, in order", () => {
    const before = snapshotOf(pull(), undefined)

    expect(changesSince(pull({ events: [queued] }), before)).toEqual([{ kind: "lifecycle", event: queued }])
    const afterQueue = snapshotOf(pull({ events: [queued] }), before)
    expect(changesSince(pull({ events: [queued, kicked, merged], merged: true }), afterQueue)).toEqual([
      { kind: "lifecycle", event: kicked },
      { kind: "lifecycle", event: merged }
    ])
  })

  it("records what already happened when it first sees a pull request, and does not repeat events it has seen", () => {
    const both = pull({ events: [queued, merged], merged: true })

    expect(changesSince(both, undefined)).toEqual([])
    expect(changesSince(both, snapshotOf(both, undefined))).toEqual([])
  })

  it("catches an entry and an exit that both happened between two checks", () => {
    const before = snapshotOf(pull(), undefined)

    expect(
      changesSince(pull({ events: [queued, kicked] }), before).map((change) =>
        change.kind === "lifecycle" ? change.event.kind : change.kind
      )
    ).toEqual(["queued", "unqueued"])
  })

  it("does not call a merged pull request ready to merge", () => {
    const done = pull({ decision: "APPROVED", checks: "passed", merged: true })

    expect(changesSince(done, snapshotOf(pull(), undefined))).not.toContainEqual({ kind: "ready" })
  })

  it("needs you only when the pull request was kicked out of the queue, and always counts as lifecycle", () => {
    expect([queued, kicked, merged].map((event) => needsYou({ kind: "lifecycle", event }))).toEqual([false, true, false])
    expect(isLifecycle({ kind: "lifecycle", event: merged })).toBe(true)
    expect(isLifecycle({ kind: "ready" })).toBe(false)
  })
})

describe("anyNeedsYou", () => {
  const change = (event: Lifecycle) => ({ kind: "lifecycle" as const, event })

  it("needs you for a kick, unless the pull request merged in the same batch", () => {
    expect(anyNeedsYou([change(queued), change(kicked)])).toBe(true)
    expect(anyNeedsYou([change(queued), change(kicked), change(merged)])).toBe(false)
  })

  it("still needs you for a person's comment on a pull request that merged", () => {
    expect(anyNeedsYou([change(merged), { kind: "item", item: item({ id: "a" }) }])).toBe(true)
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
