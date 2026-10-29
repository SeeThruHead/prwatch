import { Schema } from "effect"

import { Item, PullRequest } from "../src/GitHub.ts"

export const item = (overrides: Partial<typeof Item.Encoded> & Pick<typeof Item.Encoded, "id">): Item =>
  Schema.decodeUnknownSync(Item)({
    kind: "thread",
    author: "reviewer",
    bot: false,
    body: "Could this be simpler?",
    url: `https://github.com/acme/app/pull/1#${overrides.id}`,
    at: "2026-01-01T00:00:00Z",
    involvesYou: false,
    ...overrides
  })

export const pull = (overrides: Partial<typeof PullRequest.Encoded> = {}): PullRequest =>
  Schema.decodeUnknownSync(PullRequest)({
    id: "PR_1",
    key: "acme/app#1",
    repo: "acme/app",
    number: 1,
    title: "Add the thing",
    url: "https://github.com/acme/app/pull/1",
    branch: "feature/thing",
    draft: false,
    head: "abc1234def",
    checks: "pending",
    decision: null,
    mergeable: "yes",
    role: "author",
    commits: ["abc1234def"],
    items: [],
    ...overrides
  })
