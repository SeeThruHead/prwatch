import { Option, Schema } from "effect"

import { Hostname, Login, RepoSlug, Sha } from "../src/Brands.ts"
import { Raw } from "../src/Fields.ts"
import type { PullFact } from "../src/Linking.ts"
import { type Occurrence, checkRun, commitStatus, deployment, release, workflowRun } from "../src/Occurrence.ts"
import { Link, Rule } from "../src/Rules.ts"

export const repo = Schema.decodeSync(RepoSlug)("acme/shop")
export const me = Login.make("dev")
export const host = Hostname.make("laptop")

const raw = (value: unknown) => Schema.decodeUnknownSync(Raw)(value)

export const runRaw = (overrides: Record<string, unknown> = {}) =>
  raw({
    id: 101,
    name: "Deploy",
    display_title: "Deploy production",
    html_url: "https://github.com/acme/shop/actions/runs/101",
    head_sha: "abc1234",
    head_branch: "main",
    event: "push",
    status: "completed",
    conclusion: "success",
    updated_at: "2026-01-01T00:10:00Z",
    actor: { login: "dev" },
    triggering_actor: { login: "dev" },
    ...overrides
  })

export const run = (overrides: Record<string, unknown> = {}): Occurrence => Option.getOrThrow(workflowRun(repo, runRaw(overrides)))

export const deploymentOf = (overrides: Record<string, unknown> = {}): Occurrence =>
  Option.getOrThrow(
    deployment(
      repo,
      raw({
        id: 7,
        sha: "abc1234",
        ref: "main",
        environment: "production",
        description: "ship it",
        state: "success",
        log_url: "https://example.test/log",
        updated_at: "2026-01-01T00:10:00Z",
        creator: { login: "dev" },
        ...overrides
      })
    )
  )

export const releaseOf = (overrides: Record<string, unknown> = {}) =>
  release(
    repo,
    raw({
      id: 9,
      tag_name: "v1.2.3",
      name: "1.2.3",
      html_url: "https://github.com/acme/shop/releases/tag/v1.2.3",
      target_commitish: "main",
      draft: false,
      published_at: "2026-01-01T00:10:00Z",
      author: { login: "dev" },
      ...overrides
    })
  )

export const checkOf = (overrides: Record<string, unknown> = {}) =>
  checkRun(
    repo,
    raw({
      id: 5,
      name: "build",
      html_url: "https://github.com/acme/shop/runs/5",
      head_sha: "abc1234",
      status: "completed",
      conclusion: "failure",
      completed_at: "2026-01-01T00:10:00Z",
      check_suite: { head_branch: "feature/x" },
      app: { slug: "circleci-checks" },
      ...overrides
    })
  )

export const statusOf = (overrides: Record<string, unknown> = {}) =>
  commitStatus(
    repo,
    raw({
      id: 3,
      sha: "abc1234",
      state: "pending",
      context: "ci/build: main",
      description: "building",
      updated_at: "2026-01-01T00:10:00Z",
      creator: { login: "dev" },
      ...overrides
    })
  )

export const rule = (overrides: Record<string, unknown> = {}) =>
  Schema.decodeUnknownSync(Rule)({ name: "r", repos: ["acme/*"], link: "any", ...overrides })

export const merged = (overrides: Partial<PullFact> = {}): PullFact => ({
  number: Schema.decodeUnknownSync(Schema.Int.pipe(Schema.brand("PrNumber")))(7),
  open: false,
  merged: true,
  head: Sha.make("feedbee"),
  mergeCommit: Option.some(Sha.make("abc1234")),
  author: me,
  ...overrides
})

export const link = (value: unknown) => Schema.decodeUnknownSync(Link)(value)
