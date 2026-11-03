import { Option, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { Run, SeenBranch, SeenBranches, branchChanges } from "../src/Branches.ts"
import { failedJobNames, runOf } from "../src/Gitea.ts"
import { FilePath, RunId, Sha, Text, Url, agentId, branch, forgeHost, repoSlug } from "../src/Brands.ts"
import { branchMessage } from "../src/Message.ts"
import { type Placed, branchTargets, keptBranches } from "../src/Watcher.ts"
import { pull } from "./fixtures.ts"

const seenOf = Schema.decodeUnknownSync(SeenBranch)
const seenAll = Schema.decodeUnknownSync(SeenBranches)

const run = (id: number, workflow: string, outcome: Run["outcome"], done = true): Run =>
  Schema.decodeSync(Run)({
    id,
    workflow,
    title: `commit ${id}`,
    url: `https://gitea.example.lan/sth/app/actions/runs/${id}`,
    head: `sha${id}000000`,
    event: "push",
    done,
    outcome
  })

const gitea = forgeHost(Text.make("gitea.example.lan"))

const agent = (pane: string, overrides: Partial<Placed> = {}): Placed => ({
  id: agentId(pane),
  cwd: FilePath.make("/work/app"),
  label: Text.make(`claude in ${pane}`),
  status: "idle",
  host: gitea,
  repo: repoSlug("sth/app"),
  branch: Option.some(branch("main")),
  commit: Sha.make("abc"),
  ...overrides
})

describe("branch CI changes", () => {
  it("the first look at a branch only records what is there", () => {
    const { changes, next } = branchChanges(
      [run(1, "ci.yml", "failed"), run(2, "nightly.yml", "passed"), run(3, "ci.yml", "other", false)],
      undefined
    )

    expect(changes).toEqual([])
    expect(next).toEqual({ done: [1, 2], failing: ["ci.yml"] })
  })

  it("reports each newly finished failure, and a pass only when that workflow was failing", () => {
    const seen = seenOf({ done: [1, 2], failing: ["ci.yml"] })
    const { changes, next } = branchChanges(
      [
        run(1, "ci.yml", "failed"),
        run(2, "nightly.yml", "passed"),
        run(3, "nightly.yml", "failed"),
        run(4, "ci.yml", "passed"),
        run(5, "lint.yml", "passed")
      ],
      seen
    )

    expect(changes.map((change) => [change.kind, change.run.id])).toEqual([
      ["failed", 3],
      ["fixed", 4]
    ])
    expect(next).toEqual({ done: [1, 2, 3, 4, 5], failing: ["nightly.yml"] })
  })

  it("a run that finishes after a later one is still reported, and running or cancelled runs say nothing", () => {
    const first = branchChanges([run(7, "ci.yml", "other", false), run(8, "nightly.yml", "passed")], seenOf({ done: [], failing: [] }))
    const second = branchChanges([run(7, "ci.yml", "failed"), run(8, "nightly.yml", "passed"), run(9, "ci.yml", "other")], first.next)

    expect(first.changes).toEqual([])
    expect(second.changes.map((change) => change.run.id)).toEqual([7])
    expect(second.next.failing).toEqual(["ci.yml"])
  })
})

describe("which branches are watched", () => {
  it("one target per Gitea repo and branch, skipping detached heads, other forges and branches with an open pull request", () => {
    const targets = branchTargets(
      [
        agent("w1:p1"),
        agent("w1:p2"),
        agent("w1:p3", { branch: Option.none() }),
        agent("w1:p4", { host: forgeHost(Text.make("github.com")) }),
        agent("w1:p5", { branch: Option.some(branch("feature/thing")) })
      ],
      [pull({ host: gitea, repo: repoSlug("sth/app"), branch: branch("feature/thing") })],
      gitea
    )

    expect(targets.map((target) => [target.key, target.agents.map((entry) => entry.id)])).toEqual([
      ["gitea.example.lan/sth/app@main", ["w1:p1", "w1:p2"]]
    ])
  })

  it("keeps what it last saw of branches it could not read this time, and drops branches nobody is on", () => {
    const targets = branchTargets([agent("w1:p1")], [], gitea)
    const seen = seenAll({
      "gitea.example.lan/sth/app@main": { done: [1], failing: [] },
      "gitea.example.lan/sth/gone@main": { done: [2], failing: [] }
    })

    expect(keptBranches(seen, targets, seenAll({}))).toEqual({ "gitea.example.lan/sth/app@main": { done: [1], failing: [] } })
    expect(keptBranches(seen, targets, seenAll({ "gitea.example.lan/sth/app@main": { done: [1, 3], failing: ["ci.yml"] } }))).toEqual({
      "gitea.example.lan/sth/app@main": { done: [1, 3], failing: ["ci.yml"] }
    })
  })
})

describe("reading Gitea Actions", () => {
  it("names a run by its workflow file and reads its outcome", () => {
    const base = {
      id: RunId.make(9),
      display_title: Text.make("fix"),
      html_url: Url.make("u"),
      head_sha: Sha.make("abc"),
      event: Text.make("schedule"),
      path: Text.make("nightly.yml@refs/heads/main")
    }

    expect(runOf({ ...base, status: Text.make("completed"), conclusion: Text.make("failure") })).toMatchObject({
      workflow: "nightly.yml",
      done: true,
      outcome: "failed"
    })
    expect(runOf({ ...base, status: Text.make("completed"), conclusion: Text.make("success") }).outcome).toBe("passed")
    expect(runOf({ ...base, status: Text.make("running") })).toMatchObject({ done: false, outcome: "other" })
    expect(
      failedJobNames({
        jobs: [
          { name: Text.make("check (a)"), conclusion: Text.make("failure") },
          { name: Text.make("check (b)"), conclusion: Text.make("success") }
        ]
      })
    ).toEqual(["check (a)"])
    expect(failedJobNames({ jobs: null })).toEqual([])
  })
})

describe("the branch message", () => {
  it("lists failures with their jobs and recoveries, then the instructions", () => {
    const message = branchMessage(
      { repo: repoSlug("sth/app"), branch: branch("main") },
      [
        { kind: "failed", run: run(3, "nightly.yml", "failed"), jobs: [Text.make("check (budget)")] },
        { kind: "fixed", run: run(4, "ci.yml", "passed") }
      ],
      Text.make("Fix it.")
    )

    expect(message.split("\n")).toEqual([
      "[prwatch] sth/app branch main has CI updates:",
      '- CI failed: nightly.yml (push) on sha3000 "commit 3", failed jobs: check (budget) https://gitea.example.lan/sth/app/actions/runs/3',
      '- CI passed again: ci.yml (push) on sha4000 "commit 4" https://gitea.example.lan/sth/app/actions/runs/4',
      "Fix it."
    ])
  })
})
