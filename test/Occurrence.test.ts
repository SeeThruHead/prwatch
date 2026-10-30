import { Option } from "effect"
import { describe, expect, it } from "vitest"

import { checkOf, deploymentOf, releaseOf, run, statusOf } from "./runs.ts"

describe("workflow runs", () => {
  it("maps status and conclusion to an outcome", () => {
    expect(run().outcome).toBe("succeeded")
    expect(run({ status: "in_progress", conclusion: null }).outcome).toBe("started")
    expect(run({ conclusion: "cancelled" }).outcome).toBe("cancelled")
    expect(run({ conclusion: "timed_out" }).outcome).toBe("failed")
    expect(run({ conclusion: "skipped" }).outcome).toBe("completed")
  })

  it("names the run by its title, the branch, and who triggered it", () => {
    const found = run({ actor: { login: "original" }, triggering_actor: { login: "rerunner" } })

    expect(found.title).toBe("Deploy: Deploy production")
    expect(found.branch).toEqual(Option.some("main"))
    expect(found.actor).toEqual(Option.some("rerunner"))
    expect(found.key).toBe("workflow_run:acme/shop:101")
    expect(found.pending).toEqual({ key: "workflow_run:acme/shop:101", source: "workflow_run", repo: "acme/shop", ref: "101" })
  })
})

describe("deployments", () => {
  it("maps the latest deployment state", () => {
    expect(deploymentOf().outcome).toBe("succeeded")
    expect(deploymentOf({ state: "in_progress" }).outcome).toBe("started")
    expect(deploymentOf({ state: "error" }).outcome).toBe("failed")
    expect(deploymentOf({ state: "inactive" }).outcome).toBe("completed")
  })

  it("names the environment and links to the log", () => {
    const found = deploymentOf()

    expect(found.title).toBe("production deployment: ship it")
    expect(found.url).toBe("https://example.test/log")
  })
})

describe("releases", () => {
  it("counts a published release as succeeded and ignores drafts", () => {
    expect(Option.map(releaseOf(), (found) => found.outcome)).toEqual(Option.some("succeeded"))
    expect(Option.isNone(releaseOf({ draft: true }))).toBe(true)
    expect(Option.isNone(releaseOf({ published_at: null }))).toBe(true)
  })
})

describe("check runs and commit statuses", () => {
  it("reads the branch from the check suite and the outcome from the conclusion", () => {
    const found = Option.getOrThrow(checkOf())

    expect(found.outcome).toBe("failed")
    expect(found.branch).toEqual(Option.some("feature/x"))
  })

  it("keys a status by commit and context so each context is tracked on its own", () => {
    const found = Option.getOrThrow(statusOf())

    expect(found.outcome).toBe("started")
    expect(found.pending).toEqual({
      key: "commit_status:acme/shop:abc1234:ci/build: main",
      source: "commit_status",
      repo: "acme/shop",
      ref: "abc1234",
      context: "ci/build: main"
    })
  })
})
