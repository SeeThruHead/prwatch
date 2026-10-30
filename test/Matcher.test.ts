import { describe, expect, it } from "vitest"

import { problems, ruleMatches } from "../src/Matcher.ts"
import { host, rule, run } from "./runs.ts"

describe("ruleMatches", () => {
  it("matches on repo, event, workflow name and branch globs together", () => {
    const deploy = rule({ events: ["push"], workflows: ["*Deploy*"], branches: ["main"] })

    expect(ruleMatches(deploy, run(), host)).toBe(true)
    expect(ruleMatches(deploy, run({ event: "pull_request" }), host)).toBe(false)
    expect(ruleMatches(deploy, run({ head_branch: "feature/x" }), host)).toBe(false)
    expect(ruleMatches(rule({ repos: ["other/*"] }), run(), host)).toBe(false)
  })

  it("treats a list of globs as any-of and ignores case", () => {
    expect(ruleMatches(rule({ workflows: ["build", "DEPLOY"] }), run(), host)).toBe(true)
  })

  it("applies each kind of condition to any field of the payload", () => {
    const conditions = [
      { field: "actor.login", glob: "d*" },
      { field: "conclusion", in: ["success", "neutral"] },
      { field: "display_title", regex: "^Deploy (prod|stage)" },
      { field: "head_branch", exists: true }
    ]

    expect(ruleMatches(rule({ where: conditions }), run(), host)).toBe(true)
    expect(ruleMatches(rule({ where: [{ field: "conclusion", in: ["failure"] }] }), run(), host)).toBe(false)
    expect(ruleMatches(rule({ where: [{ field: "pull_requests.number", exists: true }] }), run(), host)).toBe(false)
  })

  it("matches a field inside every element of an array", () => {
    const labelled = run({ labels: [{ name: "ship" }, { name: "hotfix" }] })

    expect(ruleMatches(rule({ where: [{ field: "labels.name", in: ["hotfix"] }] }), labelled, host)).toBe(true)
  })

  it("only applies on the machines it names", () => {
    expect(ruleMatches(rule({ machines: ["laptop", "work-*"] }), run(), host)).toBe(true)
    expect(ruleMatches(rule({ machines: ["work-*"] }), run(), host)).toBe(false)
  })

  it("does not match an occurrence from another source", () => {
    expect(ruleMatches(rule({ source: "deployment" }), run(), host)).toBe(false)
  })

  it("never matches a condition whose regular expression does not compile", () => {
    expect(ruleMatches(rule({ where: [{ field: "name", regex: "(" }] }), run(), host)).toBe(false)
  })
})

describe("problems", () => {
  it("reports a regular expression that does not compile, in a condition and in an extraction", () => {
    const broken = rule({
      name: "broken",
      where: [{ field: "name", regex: "(" }],
      link: { extract: { from: "name", regex: "[", as: "branch" } }
    })

    expect(problems([broken])).toHaveLength(2)
  })

  it("reports a shortcut that has no field for the rule's source", () => {
    expect(problems([rule({ name: "envs", environments: ["prod"] })])).toEqual([
      "envs: environments does not apply to workflow_run; use where with a field instead"
    ])
    expect(problems([rule({ source: "deployment", environments: ["prod"], branches: ["main"] })])).toEqual([])
  })

  it("reports repos that have no literal owner to list", () => {
    expect(problems([rule({ name: "wide", repos: ["*/shop"] })])).toEqual(["wide: repos entry */shop needs a literal owner, like owner/*"])
  })
})
