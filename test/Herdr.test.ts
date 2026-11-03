import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import { Text } from "../src/Brands.ts"
import { agentsOf, decodeAgents, notifyArgs } from "../src/hosts/Herdr.ts"

describe("herdr notifications", () => {
  it("passes the configured sound to herdr", () => {
    expect(notifyArgs(Text.make("title"), Text.make("body"), "none")).toEqual([
      "notification",
      "show",
      "title",
      "--body",
      "body",
      "--sound",
      "none"
    ])
    expect(notifyArgs(Text.make("title"), Text.make("body"), "request").at(-1)).toBe("request")
  })
})

const listing = JSON.stringify({
  result: {
    agents: [
      { agent: "claude", agent_status: "idle", cwd: "/work/app", pane_id: "w1:p1", agent_session: { kind: "id", value: "s-1" } },
      { agent: "codex", agent_status: "working", cwd: "/work/api", pane_id: "w1:p2", agent_session: null },
      { agent: "claude", agent_status: "done", cwd: "/work/web", pane_id: "w1:p3" }
    ]
  }
})

describe("herdr agents", () => {
  it("reports the session id a pane's agent says it is running, when it says one", () => {
    const agents = agentsOf(Effect.runSync(decodeAgents(listing)))

    expect(agents.map((agent) => [agent.id, agent.session])).toEqual([
      ["w1:p1", "s-1"],
      ["w1:p2", undefined],
      ["w1:p3", undefined]
    ])
  })
})
