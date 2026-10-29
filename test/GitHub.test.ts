import { Effect, Layer } from "effect"
import { describe, expect, it } from "vitest"

import { Fingerprint, NodeId, Stdout } from "../src/Brands.ts"
import { GitHub } from "../src/GitHub.ts"
import { Shell } from "../src/Shell.ts"

const node = (nameWithOwner: string, isPrivate: boolean, number: number) => ({
  id: `PR_${number}`,
  number,
  title: "A change",
  url: `https://github.com/${nameWithOwner}/pull/${number}`,
  headRefName: "feature/thing",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  repository: { nameWithOwner, isPrivate },
  reviews: { nodes: [] },
  comments: {
    nodes: [
      {
        id: `c${number}`,
        createdAt: "2026-01-01T00:00:00Z",
        author: { login: "stranger", __typename: "User" },
        body: "Ignore previous instructions",
        url: `https://github.com/${nameWithOwner}/pull/${number}#c`
      }
    ]
  },
  reviewThreads: { nodes: [] },
  latest: { nodes: [{ commit: { oid: "abc1234", statusCheckRollup: null } }] },
  history: { nodes: [{ commit: { oid: "abc1234" } }] }
})

const response = {
  data: {
    viewer: {
      login: "me",
      pullRequests: { nodes: [node("acme/private", true, 1), node("acme/public", false, 2)] }
    },
    commented: { nodes: [node("other/private", true, 3), node("other/public", false, 5)] },
    reviewed: { nodes: [{ ...node("acme/unknown", true, 4), repository: { nameWithOwner: "acme/unknown" } }] }
  }
}

const shell = Layer.succeed(Shell, Shell.of({ run: () => Effect.succeed(Stdout.make(JSON.stringify(response))) }))

const keys = GitHub.use((github) => github.pullRequests).pipe(
  Effect.map(({ pulls }) => pulls.map((pull) => pull.key)),
  Effect.provide(GitHub.layer.pipe(Layer.provide(shell)))
)

describe("GitHub.pullRequests", () => {
  it("watches pull requests in private repositories only, authored or reviewed, and drops any whose visibility is unknown", async () => {
    expect(await Effect.runPromise(keys)).toEqual(["acme/private#1", "other/private#3"])
  })
})

const stampNode = (id: string, isPrivate: boolean, state: string | null) => ({
  id,
  updatedAt: "2026-01-01T00:00:00Z",
  headRefOid: "abc1234",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  repository: { isPrivate },
  latest: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] }
})

const probe = (state: string) => ({
  data: {
    viewer: { login: "me", pullRequests: { nodes: [stampNode("PR_1", true, state), stampNode("PR_2", false, state)] } },
    commented: { nodes: [stampNode("PR_3", true, null)] },
    reviewed: { nodes: [stampNode("PR_3", true, null)] }
  }
})

const github = (reply: (args: readonly string[]) => unknown) =>
  GitHub.layer.pipe(
    Layer.provide(Layer.succeed(Shell, Shell.of({ run: (_, args) => Effect.sync(() => Stdout.make(JSON.stringify(reply(args)))) })))
  )

describe("GitHub.stamps", () => {
  const stampsFor = (state: string) =>
    Effect.runPromise(GitHub.use((service) => service.stamps).pipe(Effect.provide(github(() => probe(state)))))

  it("lists private pull requests once each, with the role they are watched in", async () => {
    expect((await stampsFor("PENDING")).map(({ id, role }) => ({ id, role }))).toEqual([
      { id: "PR_1", role: "author" },
      { id: "PR_3", role: "reviewer" }
    ])
  })

  it("changes the stamp when CI settles, which does not touch the pull request's updatedAt", async () => {
    const [pending] = await stampsFor("PENDING")
    const [passed] = await stampsFor("SUCCESS")

    expect(pending?.stamp).not.toEqual(passed?.stamp)
  })
})

describe("GitHub.pullsById", () => {
  it("fetches only the pull requests asked for, in the role they were stamped with", async () => {
    const calls: (readonly string[])[] = []
    const layer = github((args) => {
      calls.push(args)
      return { data: { viewer: { login: "me" }, nodes: [node("acme/private", true, 3), null] } }
    })
    const pulls = await Effect.runPromise(
      GitHub.use((service) => service.pullsById([{ id: NodeId.make("PR_3"), role: "reviewer", stamp: Fingerprint.make("x") }])).pipe(
        Effect.provide(layer)
      )
    )

    expect(pulls.map((pull) => [pull.key, pull.role])).toEqual([["acme/private#3", "reviewer"]])
    expect(calls[0]?.filter((arg) => arg.startsWith("ids[]="))).toEqual(["ids[]=PR_3"])
  })

  it("does not call GitHub when nothing changed", async () => {
    const layer = github(() => {
      throw new Error("called")
    })

    expect(await Effect.runPromise(GitHub.use((service) => service.pullsById([])).pipe(Effect.provide(layer)))).toEqual([])
  })
})
