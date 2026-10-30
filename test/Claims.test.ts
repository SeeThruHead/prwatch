import { Option } from "effect"
import { describe, expect, it } from "vitest"

import type { Agent } from "../src/Host.ts"
import { FilePath, Sha, Text, agentId, branch, repoSlug } from "../src/Brands.ts"
import { liveClaims, recipients } from "../src/Watcher.ts"
import { pull } from "./fixtures.ts"

const reviewer: Agent = { id: agentId("w1:p9"), cwd: FilePath.make("/elsewhere"), label: Text.make("claude in w1:p9"), status: "working" }
const worktree: Agent = { id: agentId("w2:p1"), cwd: FilePath.make("/work/app"), label: Text.make("claude in w2:p1"), status: "idle" }
const placed = [{ ...worktree, repo: repoSlug("acme/app"), branch: Option.some(branch("feature/thing")), commit: Sha.make("x") }]
const claims = { "acme/app#1": [{ agent: "w1:p9", at: "2026-01-01T00:00:00Z" }] }

describe("recipients", () => {
  it("sends to the pane that claimed the pull request, wherever it works, and to the worktree on that branch", () => {
    expect(recipients(pull(), { agents: [reviewer, worktree], placed }, claims).map((agent) => agent.id)).toEqual(["w1:p9", "w2:p1"])
  })

  it("sends to a session that replaced the claiming pane, and keeps that claim alive", () => {
    const session: Agent = { ...reviewer, id: agentId("claude:s-1"), aliases: [agentId("w1:p9")] }
    expect(recipients(pull(), { agents: [session, worktree], placed }, claims).map((agent) => agent.id)).toEqual(["claude:s-1", "w2:p1"])
    expect(liveClaims(claims, [pull()], [session])).toEqual(claims)
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
