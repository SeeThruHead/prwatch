import { DateTime } from "effect"
import { describe, expect, it } from "vitest"

import type { Stamp } from "../src/GitHub.ts"
import { Fingerprint, NodeId } from "../src/Brands.ts"
import { type Synced, movedSince, refreshed } from "../src/Watcher.ts"
import { pull } from "./fixtures.ts"

const stamp = (id: string, value: string): Stamp => ({ id: NodeId.make(id), role: "author", stamp: Fingerprint.make(value) })

const second = pull({ id: "PR_2", key: "acme/app#2", number: 2 })
const synced: Synced = { at: DateTime.makeUnsafe(0), stamps: [stamp("PR_1", "a"), stamp("PR_2", "a")], pulls: [pull(), second] }

describe("movedSince", () => {
  it("picks the pull requests whose stamp changed and the ones it has not seen", () => {
    const now = [stamp("PR_1", "a"), stamp("PR_2", "b"), stamp("PR_3", "a")]

    expect(movedSince(synced, now).map((entry) => entry.id)).toEqual(["PR_2", "PR_3"])
  })
})

describe("refreshed", () => {
  it("takes fresh pull requests over known ones and drops the ones that are no longer open", () => {
    const fresh = pull({ id: "PR_2", key: second.key, number: 2, checks: "passed" })
    const pulls = refreshed(synced, [stamp("PR_2", "b")], [fresh])

    expect(pulls.map((entry) => [entry.id, entry.checks])).toEqual([["PR_2", "passed"]])
  })
})
