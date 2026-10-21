import { Option } from "effect"
import { describe, expect, it } from "vitest"

import type { Agent } from "../src/Host.ts"
import { agentId, branch, repoSlug } from "../src/Ids.ts"
import { liveClaims, recipients } from "../src/Watcher.ts"
import { pull } from "./fixtures.ts"

const reviewer: Agent = { id: agentId("w1:p9"), cwd: "/elsewhere", label: "claude in w1:p9", status: "working" }
const worktree: Agent = { id: agentId("w2:p1"), cwd: "/work/app", label: "claude in w2:p1", status: "idle" }
const placed = [{ ...worktree, repo: repoSlug("acme/app"), branch: Option.some(branch("feature/thing")), commit: "x" }]
const claims = { "acme/app#1": [{ agent: "w1:p9", at: "2026-01-01T00:00:00Z" }] }

describe("recipients", () => {
  it("sends to the pane that claimed the pull request, wherever it works, and to the worktree on that branch", () => {
    expect(recipients(pull(), { agents: [reviewer, worktree], placed }, claims).map((agent) => agent.id)).toEqual(["w1:p9", "w2:p1"])
  })

  it("skips a claiming pane that is blocked on a question", () => {
    const blocked = { ...reviewer, status: "blocked" as const }
    expect(recipients(pull(), { agents: [blocked, worktree], placed }, claims).map((agent) => agent.id)).toEqual(["w2:p1"])
  })
})

describe("liveClaims", () => {
  it("drops claims for closed pull requests and for panes that are gone", () => {
    const stale = {
      ...claims,
      "acme/app#2": [{ agent: "w1:p9", at: "2026-01-01T00:00:00Z" }],
      "acme/app#1": [...claims["acme/app#1"], { agent: "w9:p9", at: "x" }]
    }

    expect(liveClaims(stale, [pull()], [reviewer])).toEqual(claims)
  })
})
