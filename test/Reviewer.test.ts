import { Option } from "effect"
import { describe, expect, it } from "vitest"

import { changesSince, snapshotOf } from "../src/Changes.ts"
import { agentId, branch, repoSlug } from "../src/Ids.ts"
import { agentMessage } from "../src/Message.ts"
import { type Placed, onBranch } from "../src/Watcher.ts"
import { item, pull } from "./fixtures.ts"

const reviewing = pull({ role: "reviewer", commits: ["old0000", "abc1234def"] })

const agent = (overrides: Partial<Placed>): Placed => ({
  id: agentId("w1:p1"),
  cwd: "/work/app",
  label: "claude in w1:p1",
  status: "idle",
  repo: repoSlug("acme/app"),
  branch: Option.none(),
  commit: "abc1234def",
  ...overrides
})

describe("reviewer pull requests", () => {
  it("report replies and new commits, but not CI or approvals", () => {
    const before = snapshotOf(reviewing, undefined)
    const after = pull({
      ...reviewing,
      head: "fff9999",
      checks: "failed",
      decision: "APPROVED",
      items: [item({ id: "r1", involvesYou: true })]
    })

    expect(changesSince(after, before).map((change) => change.kind)).toEqual(["item", "pushed"])
  })

  it("say the user is reviewing", () => {
    expect(agentMessage(reviewing, [{ kind: "pushed", head: "fff9999abc" }], "Draft it.")).toContain(
      "which the user is reviewing, has updates:\n- new commits pushed, head is now fff9999"
    )
  })
})

describe("onBranch", () => {
  it("matches a detached checkout at one of the pull request's commits", () => {
    expect(onBranch(reviewing)(agent({ commit: "old0000" }))).toBe(true)
    expect(onBranch(reviewing)(agent({ commit: "elsewhere" }))).toBe(false)
  })

  it("matches the head branch or a pr-<number> branch, in the same repository only", () => {
    expect(onBranch(reviewing)(agent({ branch: Option.some(branch("feature/thing")), commit: "x" }))).toBe(true)
    expect(onBranch(reviewing)(agent({ branch: Option.some(branch("pr-1")), commit: "x" }))).toBe(true)
    expect(onBranch(reviewing)(agent({ branch: Option.some(branch("pr-12")), commit: "x" }))).toBe(false)
    expect(onBranch(reviewing)(agent({ repo: repoSlug("acme/other") }))).toBe(false)
  })
})
