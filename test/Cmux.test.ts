import { describe, expect, it } from "vitest"

import { Stdout, Text } from "../src/Brands.ts"
import { agentStatus, bracketed, fields } from "../src/hosts/Cmux.ts"

const sidebar = [
  "tab=0D0E3FBA",
  "focused_cwd=/work/app",
  "git_branch=feature/thing clean",
  "pr=#42 open https://github.com/acme/app/pull/42",
  "status_count=1",
  "  claude_code=Running icon=bolt.fill color=#4C8DFF"
].join("\n")

describe("cmux sidebar state", () => {
  it("reads key=value lines, including indented status entries", () => {
    const parsed = fields(Stdout.make(sidebar))
    expect(parsed.get("focused_cwd")).toBe("/work/app")
    expect(parsed.get("claude_code")).toBe("Running icon=bolt.fill color=#4C8DFF")
  })

  it("treats Running as working, Idle as idle, anything else as blocked, and a workspace without an agent status as no agent", () => {
    expect(agentStatus(fields(Stdout.make(sidebar)))).toEqual({ key: "claude_code", status: "working" })
    expect(agentStatus(fields(Stdout.make("claude_code=Idle")))).toEqual({ key: "claude_code", status: "idle" })
    expect(agentStatus(fields(Stdout.make("claude_code=Needs input")))).toEqual({ key: "claude_code", status: "blocked" })
    expect(agentStatus(fields(Stdout.make("focused_cwd=/work/app")))).toBeUndefined()
  })
})

describe("bracketed", () => {
  it("wraps the message in bracketed-paste markers so a multi-line message arrives as one paste", () => {
    expect(bracketed(Text.make("a\nb"))).toBe("\u001b[200~a\nb\u001b[201~")
  })
})
