import { describe, expect, it } from "vitest"

import { Schema } from "effect"

import { Fetched, checksOf, decisionOf, toPullRequest } from "../src/Gitea.ts"
import { Login, Text, forgeHost } from "../src/Brands.ts"

const host = forgeHost(Text.make("gitea.example.lan"))
const user = (login: string) => ({ login })

type RawReview = (typeof Fetched.Encoded)["reviews"][number]

const review = (id: number, login: string, state: RawReview["state"], overrides: Partial<RawReview> = {}): RawReview => ({
  id,
  state,
  body: "",
  html_url: `https://gitea.example.lan/sth/app/pulls/3#review-${id}`,
  submitted_at: "2026-01-01T00:00:00Z",
  user: user(login),
  comments_count: 0,
  ...overrides
})

const fetched = (overrides: Partial<typeof Fetched.Encoded> = {}): Fetched =>
  Schema.decodeUnknownSync(Fetched)({
    repo: "sth/app",
    pull: {
      number: 3,
      title: "Add the thing",
      html_url: "https://gitea.example.lan/sth/app/pulls/3",
      draft: false,
      mergeable: true,
      head: { ref: "feature/thing", sha: "abc1234" }
    },
    reviews: [],
    reviewComments: [],
    comments: [],
    status: { state: "pending", total_count: 1 },
    commits: [{ sha: "old0000" }, { sha: "abc1234" }],
    ...overrides
  })

describe("checksOf", () => {
  it.each([
    [{ state: "", total_count: 0 }, "none"],
    [{ state: "pending", total_count: 2 }, "pending"],
    [{ state: "success", total_count: 2 }, "passed"],
    [{ state: "warning", total_count: 2 }, "passed"],
    [{ state: "failure", total_count: 2 }, "failed"],
    [{ state: "error", total_count: 2 }, "failed"]
  ])("reads %j as %s", (status, checks) => {
    expect(checksOf(Schema.decodeUnknownSync(Fetched.fields.status)(status))).toBe(checks)
  })
})

const reviews = (raw: ReadonlyArray<ReturnType<typeof review>>) => Schema.decodeUnknownSync(Fetched.fields.reviews)(raw)

describe("decisionOf", () => {
  it("is the latest verdict of each reviewer, with changes requested winning", () => {
    expect(decisionOf(reviews([review(1, "ann", "REQUEST_CHANGES"), review(2, "ann", "APPROVED")]))).toBe("APPROVED")
    expect(decisionOf(reviews([review(1, "ann", "APPROVED"), review(2, "bob", "REQUEST_CHANGES")]))).toBe("CHANGES_REQUESTED")
    expect(decisionOf(reviews([review(1, "ann", "COMMENT")]))).toBeNull()
  })
})

describe("toPullRequest", () => {
  const thread = (id: number, login: string, body: string) => ({
    id,
    body,
    html_url: `https://gitea.example.lan/sth/app/pulls/3/files#issuecomment-${id}`,
    created_at: "2026-01-02T00:00:00Z",
    path: "src/x.ts",
    position: 4,
    original_position: 4,
    user: user(login)
  })

  it("maps the pull request and its host, branch, checks and commits", () => {
    const pull = toPullRequest(host, Login.make("sth"), "author")(fetched({ status: { state: "success", total_count: 1 } }))

    expect(pull).toMatchObject({
      key: "sth/app#3",
      host: "gitea.example.lan",
      branch: "feature/thing",
      head: "abc1234",
      checks: "passed",
      mergeable: "yes",
      commits: ["old0000", "abc1234"]
    })
  })

  it("gives the author every review, comment and thread from someone else, with GitHub's review states", () => {
    const pull = toPullRequest(
      host,
      Login.make("sth"),
      "author"
    )(
      fetched({
        reviews: [review(1, "ann", "REQUEST_CHANGES", { body: "needs work" }), review(2, "ann", "PENDING")],
        comments: [
          { id: 7, body: "looks close", html_url: "u7", created_at: "2026-01-02T00:00:00Z", user: user("bob") },
          { id: 8, body: "my note", html_url: "u8", created_at: "2026-01-02T00:00:00Z", user: user("sth") }
        ],
        reviewComments: [thread(9, "ann", "Could this be simpler?")]
      })
    )

    expect(pull.items.map((item) => [item.id, item.kind, item.state ?? "", item.line ?? 0])).toEqual([
      ["gitea-review-1", "review", "CHANGES_REQUESTED", 0],
      ["gitea-comment-7", "comment", "", 0],
      ["gitea-thread-9", "thread", "", 4]
    ])
  })

  it("gives a reviewer only replies in threads they joined and mentions of them", () => {
    const pull = toPullRequest(
      host,
      Login.make("sth"),
      "reviewer"
    )(
      fetched({
        reviewComments: [
          thread(1, "sth", "why this?"),
          thread(2, "ann", "because"),
          { ...thread(3, "bob", "other spot"), original_position: 9 }
        ],
        comments: [
          { id: 4, body: "@sth can you look", html_url: "u4", created_at: "2026-01-02T00:00:00Z", user: user("ann") },
          { id: 5, body: "unrelated", html_url: "u5", created_at: "2026-01-02T00:00:00Z", user: user("ann") }
        ]
      })
    )

    expect(pull.items.map((item) => item.id)).toEqual(["gitea-comment-4", "gitea-thread-2"])
  })

  it("marks Gitea Actions and [bot] accounts as bots", () => {
    const pull = toPullRequest(
      host,
      Login.make("sth"),
      "author"
    )(
      fetched({
        comments: [
          { id: 1, body: "ci", html_url: "u1", created_at: "2026-01-02T00:00:00Z", user: user("gitea-actions") },
          { id: 2, body: "dep", html_url: "u2", created_at: "2026-01-02T00:00:00Z", user: user("renovate[bot]") }
        ]
      })
    )

    expect(pull.items.map((item) => item.bot)).toEqual([true, true])
  })
})
