import { describe, expect, it } from "vitest"

import { FilePath, RepoSlug, Text, agentId } from "../src/Brands.ts"
import { agentsOf, checkoutOf } from "../src/hosts/Orca.ts"

const terminal = {
  handle: agentId("term_1"),
  worktreePath: FilePath.make("/work/app"),
  title: Text.make("Claude Code"),
  connected: true,
  writable: true
}
const claude = Text.make("claude")

describe("orca terminals", () => {
  it("keeps connected, writable terminals running an agent, at their worktree", () => {
    expect(agentsOf([{ ...terminal, agentIdentity: claude }])).toEqual([
      { id: "term_1", cwd: "/work/app", program: "claude", label: 'claude in orca "Claude Code"', status: "unknown" }
    ])
  })

  it("skips plain shells and terminals it cannot type into", () => {
    expect(agentsOf([terminal])).toEqual([])
    expect(agentsOf([{ ...terminal, agentIdentity: claude, writable: false }])).toEqual([])
    expect(agentsOf([{ ...terminal, agentIdentity: claude, connected: false }])).toEqual([])
  })
})

describe("checkoutOf", () => {
  const repos = [
    { path: FilePath.make("/code/other"), gitRemoteIdentity: null },
    { path: FilePath.make("/code/app"), gitRemoteIdentity: { canonicalKey: Text.make("github.com/Acme/App") } }
  ]

  it("finds the checkout whose origin is the repository, ignoring case", () => {
    expect(checkoutOf(repos, RepoSlug.make("acme/app"))).toBe("/code/app")
  })

  it("finds nothing when no checkout has that origin", () => {
    expect(checkoutOf(repos, RepoSlug.make("acme/web"))).toBeUndefined()
  })
})
