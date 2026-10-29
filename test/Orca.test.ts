import { describe, expect, it } from "vitest"

import { agentsOf } from "../src/hosts/Orca.ts"

const terminal = { handle: "term_1", worktreePath: "/work/app", title: "Claude Code", connected: true, writable: true }

describe("orca terminals", () => {
  it("keeps connected, writable terminals running an agent, at their worktree", () => {
    expect(agentsOf([{ ...terminal, agentIdentity: "claude" }])).toEqual([
      { id: "term_1", cwd: "/work/app", label: 'claude in orca "Claude Code"', status: "unknown" }
    ])
  })

  it("skips plain shells and terminals it cannot type into", () => {
    expect(agentsOf([terminal])).toEqual([])
    expect(agentsOf([{ ...terminal, agentIdentity: "claude", writable: false }])).toEqual([])
    expect(agentsOf([{ ...terminal, agentIdentity: "claude", connected: false }])).toEqual([])
  })
})
