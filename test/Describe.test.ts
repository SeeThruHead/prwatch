import { describe, expect, it } from "vitest"

import { describeRule } from "../src/Describe.ts"
import { link, rule } from "./runs.ts"

describe("describeRule", () => {
  it("says what a rule watches, how it links, and where it notifies", () => {
    expect(
      describeRule(rule({ source: "deployment", link: "merge-commit", notify: { on: ["failed", "succeeded"], to: ["pane", "menubar"] } }))
    ).toBe("deployment in acme/* · link merge-commit · failed/succeeded to pane and menubar")
  })

  it("mentions an extraction, a command and the machines a rule applies to", () => {
    const extracting = rule({
      repos: ["acme/shop", "acme/api"],
      link: link({ extract: { from: "head_branch", regex: "^pr-(\\d+)$", as: "pr-number" } }),
      command: "decide",
      machines: ["work-*"]
    })

    expect(describeRule(extracting)).toBe(
      "workflow_run in acme/shop, acme/api · link pr-number from head_branch · failed/succeeded to pane · with a command · on work-*"
    )
  })
})
