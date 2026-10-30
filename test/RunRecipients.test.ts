import { Option } from "effect"
import { describe, expect, it } from "vitest"

import { FilePath, IsoTime, PrKey, RuleName, Sha, Text, agentId, branch, repoSlug } from "../src/Brands.ts"
import type { Agent } from "../src/Host.ts"
import { runMessage, runNotification } from "../src/Message.ts"
import type { RunDelivery } from "../src/Runs.ts"
import { runRecipients } from "../src/Watcher.ts"
import { deploymentOf, run } from "./runs.ts"

const pane = (id: string, status: Agent["status"] = "idle"): Agent => ({
  id: agentId(id),
  cwd: FilePath.make("/work"),
  label: Text.make(`claude in ${id}`),
  status
})
const placed = (agent: Agent, name: string | undefined, commit = "0000000") => ({
  ...agent,
  repo: repoSlug("acme/shop"),
  branch: name === undefined ? Option.none() : Option.some(branch(name)),
  commit: Sha.make(commit)
})

const delivery = (overrides: Partial<RunDelivery> = {}): RunDelivery => ({
  occurrence: run(),
  rule: Option.some(RuleName.make("deploys")),
  linked: {
    pr: Option.some(PrKey.make("acme/shop#7")),
    branch: Option.some(branch("main")),
    sha: Sha.make("abc1234"),
    claimantsOnly: false
  },
  targets: ["pane"],
  message: Option.none(),
  watchers: [],
  ...overrides
})

const claimed = pane("w1:p1")
const onBranch = pane("w2:p2")
const elsewhere = pane("w3:p3")

describe("runRecipients", () => {
  it("sends to panes that claimed the pull request or watched the run, and to the worktree on the run's branch", () => {
    const found = { agents: [claimed, onBranch, elsewhere], placed: [placed(onBranch, "main"), placed(elsewhere, "other")] }
    const claims = { [PrKey.make("acme/shop#7")]: [{ agent: agentId("w1:p1"), at: IsoTime.make("2026-01-01T00:00:00Z") }] }

    expect(runRecipients(delivery(), found, claims).map((agent) => agent.id)).toEqual(["w1:p1", "w2:p2"])
    expect(runRecipients(delivery({ watchers: [agentId("w3:p3")] }), found, {}).map((agent) => agent.id)).toEqual(["w3:p3", "w2:p2"])
  })

  it("finds a worktree that has no branch by the commit the run built", () => {
    const found = { agents: [onBranch], placed: [placed(onBranch, undefined, "abc1234")] }

    expect(runRecipients(delivery(), found, {}).map((agent) => agent.id)).toEqual(["w2:p2"])
  })

  it("sends only to claimants when the link says so, and skips panes blocked on a question", () => {
    const found = { agents: [claimed, onBranch], placed: [placed(onBranch, "main")] }
    const watching = delivery({ watchers: [agentId("w1:p1")], linked: { ...delivery().linked, claimantsOnly: true } })

    expect(runRecipients(watching, found, {}).map((agent) => agent.id)).toEqual(["w1:p1"])
    expect(runRecipients(watching, { agents: [pane("w1:p1", "blocked")], placed: [] }, {})).toEqual([])
  })
})

describe("run messages", () => {
  it("names the run, its outcome, branch and link, then the pull request, any hook line and the instructions", () => {
    const message = runMessage(
      run({ conclusion: "failure" }),
      Option.some(PrKey.make("acme/shop#7")),
      Option.some(Text.make("rolled back")),
      Text.make("Look at the logs.")
    )

    expect(message).toBe(
      [
        '[prwatch] acme/shop workflow run "Deploy: Deploy production" failed on main (https://github.com/acme/shop/actions/runs/101)',
        "- for acme/shop#7",
        "- rolled back",
        "Look at the logs."
      ].join("\n")
    )
  })

  it("titles the desktop notification with the repo, kind and outcome", () => {
    expect(runNotification(deploymentOf())).toEqual({
      title: "acme/shop deployment succeeded",
      body: "production deployment: ship it https://example.test/log"
    })
  })
})
