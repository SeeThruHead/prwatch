import { NodeServices } from "@effect/platform-node"
import { it as effectIt } from "@effect/vitest"
import { ConfigProvider, Effect, Layer } from "effect"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

import { AgentId, FilePath, IsoTime, Login, NodeId, Stdout, Text, agentId } from "../src/Brands.ts"
import { RulesConfig } from "../src/Config.ts"
import { type DeskState, handledAfter, requesters, reviewRequests } from "../src/Desk.ts"
import { GitHub } from "../src/GitHub.ts"
import type { Agent } from "../src/Host.ts"
import { DESK_INSTRUCTIONS, deskMessage } from "../src/Message.ts"
import { Shell } from "../src/Shell.ts"
import { claimedFor, withoutDesk } from "../src/Watcher.ts"
import { item, pull } from "./fixtures.ts"

const desk: DeskState = { agent: AgentId.make("w1:p9"), since: IsoTime.make("2026-01-01T00:00:00.000Z"), handled: [] }
const from = [Login.make("Alex")]
const asked = item({ id: "c1", kind: "comment", author: "alex", body: "@me can you review this?", involvesYou: true, mentionsYou: true })
const reviewing = pull({ role: "reviewer", items: [asked] })

const requestedIds = (pulls: Parameters<typeof reviewRequests>[0], state: DeskState = desk) =>
  reviewRequests(pulls, from, state).flatMap((request) => request.items.map((entry) => entry.id))

describe("reviewRequests", () => {
  it("takes a mention from someone on the list, whatever the case of their login", () => {
    expect(requestedIds([reviewing])).toEqual(["c1"])
  })

  it("ignores mentions from anyone not on the list, and from bots", () => {
    const stranger = item({ id: "c2", kind: "comment", author: "mallory", involvesYou: true, mentionsYou: true })
    const bot = item({ id: "c3", kind: "comment", author: "alex", bot: true, involvesYou: true, mentionsYou: true })

    expect(requestedIds([pull({ role: "reviewer", items: [stranger, bot] })])).toEqual([])
  })

  it("needs an actual mention, not just a reply in a thread you are part of", () => {
    const reply = item({ id: "t1", author: "alex", involvesYou: true, mentionsYou: false })

    expect(requestedIds([pull({ role: "reviewer", items: [reply] })])).toEqual([])
  })

  it("ignores mentions made before the desk opened, ones already handled, and your own pull requests", () => {
    const old = item({ id: "c0", kind: "comment", author: "alex", at: "2025-12-31T23:59:59Z", involvesYou: true, mentionsYou: true })

    expect(requestedIds([pull({ role: "reviewer", items: [old] })])).toEqual([])
    expect(requestedIds([reviewing], { ...desk, handled: [NodeId.make("c1")] })).toEqual([])
    expect(requestedIds([pull({ role: "author", items: [asked] })])).toEqual([])
  })

  it("takes a request in the pull request description", () => {
    const description = item({ id: "PR_1", kind: "description", author: "alex", involvesYou: true, mentionsYou: true })

    expect(requestedIds([pull({ role: "reviewer", items: [description] })])).toEqual(["PR_1"])
  })

  it("asks only once for each mention", () => {
    const handled = handledAfter(desk, reviewRequests([reviewing], from, desk))

    expect(requestedIds([reviewing], handled)).toEqual([])
  })
})

const deskAgent: Agent = { id: agentId("w1:p9"), cwd: FilePath.make("/work"), label: Text.make("claude in w1:p9"), status: "idle" }
const branchAgent: Agent = { id: agentId("w2:p1"), cwd: FilePath.make("/work/app"), label: Text.make("claude in w2:p1"), status: "idle" }

describe("routing a request to the desk", () => {
  it("claims the pull request for the desk pane, keeping other claims", () => {
    const at = IsoTime.make("2026-01-02T00:00:00.000Z")
    const claims = claimedFor({ [reviewing.key]: [{ agent: branchAgent.id, at }] }, reviewRequests([reviewing], from, desk), desk.agent, at)

    expect(claims[reviewing.key]?.map((entry) => entry.agent)).toEqual([branchAgent.id, deskAgent.id])
  })

  it("does not send the desk the same mention twice in one check", () => {
    const delivery = { pull: reviewing, changes: [], agents: [deskAgent, branchAgent], needsYou: true }
    const [kept] = withoutDesk([delivery], reviewRequests([reviewing], from, desk), deskAgent)

    expect(kept?.agents).toEqual([branchAgent])
  })

  it("tells the desk who asked, what they said, and to post nothing without the user", () => {
    const [request] = reviewRequests([reviewing], from, desk)
    const message = request === undefined ? "" : deskMessage(request.pull, request.items, DESK_INSTRUCTIONS)

    expect(message).toContain(`[prwatch] review requested on acme/app#1 "Add the thing" (https://github.com/acme/app/pull/1):`)
    expect(message).toContain(`- comment from alex: "@me can you review this?"`)
    expect(message).toContain("post nothing until the user approves it")
    expect(request === undefined ? "" : requesters(request)).toBe("alex")
  })
})

const configured = (files: Record<string, unknown>) => {
  const dir = mkdtempSync(join(tmpdir(), "prwatch-desk-"))
  Object.entries(files).forEach(([name, content]) => writeFileSync(join(dir, name), JSON.stringify(content)))

  return RulesConfig.layer.pipe(
    Layer.provide(NodeServices.layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ PRWATCH_CONFIG_DIR: dir, HOME: dir })))
  )
}

describe("desk config", () => {
  effectIt.effect("reads desk.from, with config.local.json replacing config.json", () =>
    Effect.gen(function* () {
      const config = yield* RulesConfig
      expect(yield* config.desk).toEqual({ from: ["jo"] })
    }).pipe(Effect.provide(configured({ "config.json": { desk: { from: ["alex"] } }, "config.local.json": { desk: { from: ["jo"] } } })))
  )

  effectIt.effect("has no desk when neither file sets one", () =>
    Effect.gen(function* () {
      const config = yield* RulesConfig
      expect(yield* config.desk).toBeUndefined()
    }).pipe(Effect.provide(configured({ "config.json": { rules: [] } })))
  )
})

const mentionedNode = {
  id: "PR_7",
  number: 7,
  title: "Needs eyes",
  url: "https://github.com/acme/app/pull/7",
  body: "@me please review",
  createdAt: "2026-01-01T00:00:00Z",
  author: { login: "alex", __typename: "User" },
  headRefName: "feature/eyes",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  isInMergeQueue: false,
  mergedAt: null,
  lifecycle: { nodes: [] },
  repository: { nameWithOwner: "acme/app", isPrivate: true },
  reviews: { nodes: [] },
  comments: { nodes: [] },
  reviewThreads: { nodes: [] },
  latest: { nodes: [{ commit: { oid: "abc1234", statusCheckRollup: null } }] },
  history: { nodes: [{ commit: { oid: "abc1234" } }] }
}

const mentionedOnly = {
  data: {
    viewer: { login: "me", pullRequests: { nodes: [] }, merged: { nodes: [] } },
    commented: { nodes: [] },
    reviewed: { nodes: [] },
    mentioned: {
      nodes: [mentionedNode, { ...mentionedNode, id: "PR_8", number: 8, repository: { nameWithOwner: "acme/open", isPrivate: false } }]
    }
  }
}

describe("GitHub mentions", () => {
  effectIt.effect("watches a private pull request that only mentions you, with its description as an item", () =>
    Effect.gen(function* () {
      const { pulls } = yield* GitHub.use((github) => github.pullRequests)

      expect(pulls.map((entry) => [entry.key, entry.role])).toEqual([["acme/app#7", "reviewer"]])
      expect(pulls[0]?.items.map((entry) => [entry.kind, entry.author, entry.mentionsYou])).toEqual([["description", "alex", true]])
    }).pipe(
      Effect.provide(
        GitHub.layer.pipe(
          Layer.provide(Layer.succeed(Shell, Shell.of({ run: () => Effect.succeed(Stdout.make(JSON.stringify(mentionedOnly))) })))
        )
      )
    )
  )
})
