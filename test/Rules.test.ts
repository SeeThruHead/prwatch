import { Exit, Schema } from "effect"
import { describe, expect, it } from "vitest"

import { WatchRules } from "../src/Rules.ts"

const strict = { onExcessProperty: "error" } as const
const decode = (input: unknown) => Schema.decodeUnknownSync(WatchRules)(input, strict)
const rejected = (input: unknown) => Exit.isFailure(Schema.decodeUnknownExit(WatchRules)(input, strict))

const mainDeploys = {
  name: "main deploys",
  repos: ["acme/*"],
  events: ["push"],
  branches: ["main"],
  environments: ["*"],
  link: "merge-commit",
  notify: { on: ["failed", "succeeded"], to: ["pane", "menubar"] }
}

const previewDispatches = {
  name: "previews",
  repos: ["acme/shop"],
  events: ["workflow_dispatch", "pull_request"],
  workflows: ["*Preview*"],
  link: "pr-head-sha"
}

const taggedRelease = {
  name: "tagged releases",
  source: "release",
  repos: ["acme/*"],
  where: [{ field: "tag_name", regex: "^v\\d+\\.\\d+\\.\\d+$" }],
  link: "actor"
}

const externalCi = {
  name: "external ci",
  source: "check_run",
  repos: ["acme/shop"],
  where: [
    { field: "app.slug", in: ["circleci-checks"] },
    { field: "head_branch", glob: "release/*" },
    { field: "output.title", exists: true }
  ],
  link: { extract: { from: "head_branch", regex: "^pr-(\\d+)$", as: "pr-number" } }
}

const scripted = {
  name: "scripted",
  source: "deployment",
  repos: ["acme/shop"],
  link: "any",
  command: "~/bin/who-owns-this-deploy",
  machines: ["work-*"]
}

describe("WatchRules", () => {
  it("decodes a rule for deploys of anything merged to the default branch", () => {
    expect(decode({ rules: [mainDeploys] }).rules[0]?.link).toBe("merge-commit")
  })

  it("decodes a rule that attributes dispatched runs to a pull request by head commit", () => {
    const [rule] = decode({ rules: [previewDispatches] }).rules

    expect(rule?.link).toBe("pr-head-sha")
    expect(rule?.workflows).toEqual(["*Preview*"])
  })

  it("decodes tagged releases, external check runs and a script hook", () => {
    const rules = decode({ rules: [taggedRelease, externalCi, scripted] }).rules

    expect(rules.map((rule) => rule.source)).toEqual(["release", "check_run", "deployment"])
    expect(rules[2]?.command).toBe("~/bin/who-owns-this-deploy")
  })

  it("decodes every kind of field condition and a link extracted from a field", () => {
    const [rule] = decode({ rules: [externalCi] }).rules

    expect(rule?.where).toHaveLength(3)
    expect(rule?.link).toEqual({ extract: { from: "head_branch", regex: "^pr-(\\d+)$", as: "pr-number" } })
  })

  it("defaults notification to failed and succeeded in the pane", () => {
    const [rule] = decode({ rules: [{ ...previewDispatches, notify: {} }] }).rules

    expect(rule?.notify).toEqual({ on: ["failed", "succeeded"], to: ["pane"] })
  })

  it("rejects a misspelled key instead of ignoring it", () => {
    expect(rejected({ rules: [{ ...mainDeploys, enviroments: ["*"] }] })).toBe(true)
  })

  it("rejects an unknown link, source or outcome", () => {
    expect(rejected({ rules: [{ ...mainDeploys, link: "owner" }] })).toBe(true)
    expect(rejected({ rules: [{ ...mainDeploys, source: "pipeline" }] })).toBe(true)
    expect(rejected({ rules: [{ ...mainDeploys, notify: { on: ["exploded"] } }] })).toBe(true)
  })

  it("rejects a field path that is not a dotted name", () => {
    expect(rejected({ rules: [{ ...externalCi, where: [{ field: "head branch", glob: "main" }] }] })).toBe(true)
  })

  it("requires a name, repos and a link", () => {
    expect(rejected({ rules: [{ repos: ["acme/*"], link: "actor" }] })).toBe(true)
    expect(rejected({ rules: [{ name: "x", link: "actor" }] })).toBe(true)
    expect(rejected({ rules: [{ name: "x", repos: ["acme/*"] }] })).toBe(true)
  })
})
