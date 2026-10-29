import { type Item, type PullRequest } from "../src/GitHub.ts"
import { branch, prKey, repoSlug } from "../src/Ids.ts"

export const item = (overrides: Partial<Item> & Pick<Item, "id">): Item => ({
  kind: "thread",
  author: "reviewer",
  bot: false,
  body: "Could this be simpler?",
  url: `https://github.com/acme/app/pull/1#${overrides.id}`,
  at: "2026-01-01T00:00:00Z",
  involvesYou: false,
  ...overrides
})

export const pull = (overrides: Partial<PullRequest> = {}): PullRequest => {
  const repo = repoSlug("acme/app")

  return {
    id: "PR_1",
    key: prKey(repo, 1),
    repo,
    number: 1,
    title: "Add the thing",
    url: "https://github.com/acme/app/pull/1",
    branch: branch("feature/thing"),
    draft: false,
    head: "abc1234def",
    checks: "pending",
    decision: null,
    mergeable: "yes",
    role: "author",
    commits: ["abc1234def"],
    items: [],
    ...overrides
  }
}
