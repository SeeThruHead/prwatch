import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Schema } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FilePath, Stdout, Text, agentId } from "../src/Brands.ts"
import { type Agent, Host } from "../src/Host.ts"
import { Listed, agentsOf, inboxLines, preferSessions, withClaudeSessions } from "../src/hosts/Claude.ts"
import { Shell } from "../src/Shell.ts"

const listed = [
  { sessionId: "s-1", cwd: "/work/app", name: "app work", status: "idle" },
  { sessionId: "s-2", cwd: "/work/api", state: "working" },
  { sessionId: "s-3", cwd: "/work/web", state: "blocked" }
]

const pane = (id: string, cwd: string, program = "claude"): Agent => ({
  id: agentId(id),
  cwd: FilePath.make(cwd),
  program: Text.make(program),
  label: Text.make(`${program} in ${id}`),
  status: "idle"
})

const terminalDeliveries: string[] = []
const terminal = Layer.succeed(
  Host,
  Host.of({
    name: "herdr",
    agents: Effect.succeed([pane("w1:p1", "/work/app"), pane("w1:p2", "/work/other")]),
    deliver: (agent) => Effect.sync(() => void terminalDeliveries.push(agent)),
    notify: () => Effect.void
  })
)

describe("claude sessions", () => {
  it("lists each live session as an agent at its working directory", () => {
    expect(
      agentsOf(Schema.decodeUnknownSync(Schema.Array(Listed))(listed)).map((agent) => [agent.id, agent.cwd, agent.status, agent.label])
    ).toEqual([
      ["claude:s-1", "/work/app", "idle", 'claude session "app work"'],
      ["claude:s-2", "/work/api", "working", 'claude session "s-2"'],
      ["claude:s-3", "/work/web", "blocked", 'claude session "s-3"']
    ])
  })

  it("replaces a Claude pane with the only session in its worktree, which takes over the pane's claims", () => {
    const panes = [pane("w1:p1", "/work/app"), pane("w1:p3", "/work/app", "codex"), pane("w1:p2", "/work/other")]
    const agents = preferSessions([pane("claude:s-1", "/work/app")], panes)

    expect(agents.map((agent) => [agent.id, agent.aliases ?? []])).toEqual([
      ["claude:s-1", ["w1:p1"]],
      ["w1:p3", []],
      ["w1:p2", []]
    ])
  })

  it("keeps a Claude pane when several sessions share its directory, since it can't tell which one it is", () => {
    const sessions = [pane("claude:s-1", "/work/app"), pane("claude:s-2", "/work/app")]
    expect(preferSessions(sessions, [pane("w1:p1", "/work/app")]).map((agent) => agent.id)).toEqual(["claude:s-1", "claude:s-2", "w1:p1"])
  })

  it("writes one newline-terminated user message", () => {
    expect(JSON.parse(inboxLines(Text.make("hello")))).toEqual({ type: "user", message: { role: "user", content: "hello" } })
  })

  it.live("delivers to a session's inbox socket and falls back to the terminal for panes", () =>
    Effect.gen(function* () {
      const config = mkdtempSync(join(tmpdir(), "prwatch-claude-"))
      const socketPath = join(config, "inbox.sock")
      const received: string[] = []
      const server = createServer((connection) => connection.on("data", (chunk) => received.push(chunk.toString())))
      yield* Effect.callback<void>((resume) => void server.listen(socketPath, () => resume(Effect.void)))
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
      mkdirSync(join(config, "sessions"))
      writeFileSync(join(config, "sessions", "123.json"), JSON.stringify({ pid: 123, sessionId: "s-1", messagingSocketPath: socketPath }))
      writeFileSync(join(config, "sessions", "123.key"), "not json")

      const shell = Layer.succeed(Shell, Shell.of({ run: () => Effect.succeed(Stdout.make(JSON.stringify(listed))) }))
      const host = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* Host
        }),
        withClaudeSessions(terminal).pipe(
          Layer.provide(shell),
          Layer.provide(NodeServices.layer),
          Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({ CLAUDE_CONFIG_DIR: config, HOME: config })))
        )
      )

      expect((yield* host.agents).map((agent) => agent.id)).toEqual(["claude:s-1", "claude:s-2", "claude:s-3", "w1:p2"])

      yield* host.deliver(agentId("claude:s-1"), Text.make("new review on #7"))
      yield* host.deliver(agentId("w1:p2"), Text.make("ci passed"))
      yield* Effect.sleep("50 millis")

      expect(received.join("")).toBe(inboxLines(Text.make("new review on #7")))
      expect(terminalDeliveries).toEqual(["w1:p2"])

      const missing = yield* Effect.flip(host.deliver(agentId("claude:s-2"), Text.make("x")))
      expect(missing.reason).toBe("the session has no inbox socket")
    }).pipe(Effect.scoped)
  )
})
