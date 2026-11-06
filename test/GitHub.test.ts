import { it as effectIt } from "@effect/vitest"
import { Effect, Layer, Ref } from "effect"
import { describe, expect, it } from "vitest"

import { Fingerprint, NodeId, Stdout } from "../src/Brands.ts"
import { GitHub } from "../src/GitHub.ts"
import { Shell } from "../src/Shell.ts"

const node = (nameWithOwner: string, isPrivate: boolean, number: number) => ({
  id: `PR_${number}`,
  number,
  title: "A change",
  url: `https://github.com/${nameWithOwner}/pull/${number}`,
  body: "Adds a change",
  createdAt: "2026-01-01T00:00:00Z",
  author: { login: "author", __typename: "User" },
  headRefName: "feature/thing",
  isDraft: false,
  mergeable: "MERGEABLE",
  reviewDecision: null,
  isInMergeQueue: false,
  mergedAt: null,
  lifecycle: { nodes: [] },
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
      pullRequests: { nodes: [node("acme/private", true, 1), node("acme/public", false, 2)] },
      merged: { nodes: [] }
    },
    commented: { nodes: [node("other/private", true, 3), node("other/public", false, 5)] },
    reviewed: { nodes: [{ ...node("acme/unknown", true, 4), repository: { nameWithOwner: "acme/unknown" } }] },
    mentioned: { nodes: [] }
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
  isInMergeQueue: false,
  mergedAt: null,
  lifecycle: { nodes: [] },
  repository: { isPrivate },
  latest: { nodes: [{ commit: { statusCheckRollup: state === null ? null : { state } } }] }
})

const probe = (state: string) => ({
  data: {
    viewer: {
      login: "me",
      pullRequests: { nodes: [stampNode("PR_1", true, state), stampNode("PR_2", false, state)] },
      merged: { nodes: [] }
    },
    commented: { nodes: [stampNode("PR_3", true, null)] },
    reviewed: { nodes: [stampNode("PR_3", true, null)] },
    mentioned: { nodes: [] }
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
    const calls = Effect.runSync(Ref.make<readonly (readonly string[])[]>([]))
    const layer = github((args) => {
      Effect.runSync(Ref.update(calls, (all) => [...all, args]))
      return { data: { viewer: { login: "me" }, nodes: [node("acme/private", true, 3), null] } }
    })
    const pulls = await Effect.runPromise(
      GitHub.use((service) => service.pullsById([{ id: NodeId.make("PR_3"), role: "reviewer", stamp: Fingerprint.make("x") }])).pipe(
        Effect.provide(layer)
      )
    )

    expect(pulls.map((pull) => [pull.key, pull.role])).toEqual([["acme/private#3", "reviewer"]])
    expect(Effect.runSync(Ref.get(calls))[0]?.filter((arg) => arg.startsWith("ids[]="))).toEqual(["ids[]=PR_3"])
  })

  it("does not call GitHub when nothing changed", async () => {
    const layer = github(() => {
      throw new Error("called")
    })

    expect(await Effect.runPromise(GitHub.use((service) => service.pullsById([])).pipe(Effect.provide(layer)))).toEqual([])
  })
})

const event = (typename: string, id: string, createdAt: string, extra: Record<string, unknown> = {}) => ({
  __typename: typename,
  id,
  createdAt,
  ...extra
})

const queueHistory = [
  event("AddedToMergeQueueEvent", "q1", "2026-01-01T00:00:00Z"),
  event("RemovedFromMergeQueueEvent", "r1", "2026-01-01T00:10:00Z", { reason: "failed_checks" }),
  event("AddedToMergeQueueEvent", "q2", "2026-01-01T01:00:00Z"),
  event("MergedEvent", "m1", "2026-01-01T01:10:00Z", { commit: { oid: "a0f6b9396a5b03af3ccb6d35661d26793c040596" } }),
  event("RemovedFromMergeQueueEvent", "r2", "2026-01-01T01:10:00Z", { reason: "merged" })
]

const lifecycleNode = (number: number, mergedAt: string | null, nodes: readonly unknown[], queued = false) => ({
  ...node("acme/private", true, number),
  isInMergeQueue: queued,
  mergedAt,
  lifecycle: { nodes }
})

const listing = (open: readonly unknown[], merged: readonly unknown[]) => ({
  data: {
    viewer: { login: "me", pullRequests: { nodes: open }, merged: { nodes: merged } },
    commented: { nodes: [] },
    reviewed: { nodes: [] },
    mentioned: { nodes: [] }
  }
})

const pullsOf = (reply: unknown) =>
  GitHub.use((service) => service.pullRequests).pipe(
    Effect.map(({ pulls }) => pulls),
    Effect.provide(github(() => reply))
  )

describe("GitHub.pullRequests lifecycle", () => {
  effectIt.effect("reads merge queue entry, kicks with GitHub's reason, and the merge commit, and drops the normal exit", () =>
    Effect.gen(function* () {
      const [pull] = yield* pullsOf(listing([], [lifecycleNode(10, "1970-01-01T00:00:00Z", queueHistory)]))

      expect(pull?.merged).toBe(true)
      expect(pull?.events.map((entry) => [entry.id, entry.kind])).toEqual([
        ["q1", "queued"],
        ["r1", "unqueued"],
        ["q2", "queued"],
        ["m1", "merged"]
      ])
      expect(pull?.events[1]).toMatchObject({ reason: "failed_checks" })
      expect(pull?.events[3]).toMatchObject({ commit: "a0f6b9396a5b03af3ccb6d35661d26793c040596" })
    })
  )

  effectIt.effect("says so when GitHub gives no reason for a removal", () =>
    Effect.gen(function* () {
      const [pull] = yield* pullsOf(
        listing([lifecycleNode(11, null, [event("RemovedFromMergeQueueEvent", "r9", "2026-01-01T00:00:00Z", { reason: null })])], [])
      )

      expect(pull?.events).toMatchObject([{ kind: "unqueued", reason: "no reason given" }])
    })
  )

  effectIt.effect("keeps following a pull request for three days after it merges, and then lets it go", () =>
    Effect.gen(function* () {
      const recent = lifecycleNode(12, "1969-12-31T00:00:00Z", [])
      const old = lifecycleNode(13, "1969-12-20T00:00:00Z", [])
      const pulls = yield* pullsOf(listing([lifecycleNode(14, null, [], true)], [recent, old]))

      expect(pulls.map((pull) => [pull.number, pull.queued, pull.merged])).toEqual([
        [14, true, false],
        [12, false, true]
      ])
    })
  )

  effectIt.effect("reports queue events for pull requests you wrote, not for ones you review", () =>
    Effect.gen(function* () {
      const reviewing = { ...lifecycleNode(15, null, queueHistory), number: 15 }
      const reply = {
        data: {
          viewer: { login: "me", pullRequests: { nodes: [] }, merged: { nodes: [] } },
          commented: { nodes: [reviewing] },
          reviewed: { nodes: [] },
          mentioned: { nodes: [] }
        }
      }
      const [pull] = yield* pullsOf(reply)

      expect([pull?.role, pull?.events]).toEqual(["reviewer", []])
    })
  )
})

describe("GitHub.stamps lifecycle", () => {
  const stampWith = (lifecycleId: string | null, queued: boolean, mergedAt: string | null) =>
    Effect.runPromise(
      GitHub.use((service) => service.stamps).pipe(
        Effect.provide(
          github(() => ({
            data: {
              viewer: {
                login: "me",
                pullRequests: {
                  nodes: [
                    {
                      ...stampNode("PR_1", true, null),
                      isInMergeQueue: queued,
                      mergedAt,
                      lifecycle: { nodes: lifecycleId === null ? [] : [{ id: lifecycleId }] }
                    }
                  ]
                },
                merged: { nodes: [] }
              },
              commented: { nodes: [] },
              reviewed: { nodes: [] },
              mentioned: { nodes: [] }
            }
          }))
        )
      )
    )

  it("changes the stamp when the pull request enters or leaves the queue or merges", async () => {
    const idle = (await stampWith(null, false, null))[0]?.stamp
    const queued = (await stampWith("q1", true, null))[0]?.stamp
    const kicked = (await stampWith("r1", false, null))[0]?.stamp
    const merged = (await stampWith("m1", false, "2026-01-01T00:00:00Z"))[0]?.stamp

    expect(new Set([idle, queued, kicked, merged]).size).toBe(4)
  })
})
