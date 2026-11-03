import { NodeServices } from "@effect/platform-node"
import { describe, expect, it } from "@effect/vitest"
import { ConfigProvider, Effect, Layer, Option, Schema } from "effect"
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"
import { tmpdir } from "node:os"
import { join } from "node:path"

import { FilePath, Stdout, Text, agentId } from "../src/Brands.ts"
import { type Agent, Host } from "../src/Host.ts"
import { type Caller, Listed, agentsOf, claimTarget, inboxLines, preferPanes, withClaudeSessions } from "../src/hosts/Claude.ts"
import { Shell } from "../src/Shell.ts"

const listed = [
  { sessionId: "s-1", cwd: "/work/app", name: "app work", status: "idle" },
  { sessionId: "s-2", cwd: "/work/api", state: "working" },
  { sessionId: "s-3", cwd: "/work/web", state: "blocked" }
]

const caller = (session: string, cwd: string): Caller => ({ agent: agentId(`claude:${session}`), cwd: Option.some(FilePath.make(cwd)) })

const on = (id: string) => Option.some(agentId(id))

const pane = (id: string, cwd: string, program = "claude", session?: string): Agent => ({
  id: agentId(id),
  cwd: FilePath.make(cwd),
  program: Text.make(program),
  ...(session === undefined ? {} : { session: Text.make(session) }),
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

  it("leaves a session in the pane that holds it, and that pane answers to the session's claims", () => {
    const panes = [pane("w1:p1", "/work/app"), pane("w1:p3", "/work/app", "codex"), pane("w1:p2", "/work/other")]
    const agents = preferPanes([pane("claude:s-1", "/work/app")], panes)

    expect(agents.map((agent) => [agent.id, agent.aliases ?? []])).toEqual([
      ["w1:p1", ["claude:s-1"]],
      ["w1:p3", []],
      ["w1:p2", []]
    ])
  })

  it("pairs a session with the pane that reports its id, whatever the directory", () => {
    const panes = [pane("w1:p1", "/elsewhere", "claude", "s-1"), pane("w1:p2", "/work/app", "claude", "s-9")]
    const agents = preferPanes([pane("claude:s-1", "/work/app")], panes)

    expect(agents.map((agent) => [agent.id, agent.aliases ?? []])).toEqual([
      ["w1:p1", ["claude:s-1"]],
      ["w1:p2", []]
    ])
  })

  it("keeps a session of its own when no pane holds it, or when several sessions share a directory with the only pane", () => {
    const sessions = [pane("claude:s-1", "/work/app"), pane("claude:s-2", "/work/app")]

    expect(preferPanes(sessions, [pane("w1:p1", "/work/app")]).map((agent) => agent.id)).toEqual(["w1:p1", "claude:s-1", "claude:s-2"])
    expect(preferPanes([pane("claude:s-1", "/work/app")], []).map((agent) => agent.id)).toEqual(["claude:s-1"])
  })

  it("treats the program names cmux and orca report for Claude as Claude", () => {
    const panes = [pane("workspace-1", "/work/app", "claude_code"), pane("terminal-2", "/work/api", "claude-code")]

    expect(preferPanes([pane("claude:s-1", "/work/app")], panes).map((agent) => [agent.id, agent.aliases ?? []])).toEqual([
      ["workspace-1", ["claude:s-1"]],
      ["terminal-2", []]
    ])
    expect(claimTarget(caller("s-2", "/work/api"), on("terminal-2"), panes)).toBe("terminal-2")
  })

  it("never claims the session while any pane holds it", () => {
    const heldByReport = [pane("w1:p1", "/elsewhere", "claude", "s-1")]
    const heldByDirectory = [pane("w1:p1", "/work/app")]

    expect(claimTarget(caller("s-1", "/work/app"), Option.none(), heldByReport)).toBe("w1:p1")
    expect(claimTarget(caller("s-1", "/work/app"), on("w1:p1"), heldByDirectory)).toBe("w1:p1")
  })

  it("claims the pane that reports the session, ignoring a stale pane id", () => {
    const panes = [pane("w1:p1", "/work/app", "claude", "s-1"), pane("w1:p2", "/work/app", "claude", "s-2")]

    expect(claimTarget(caller("s-1", "/work/app"), on("w1:p2"), panes)).toBe("w1:p1")
  })

  it("claims the pane the environment names when it is a Claude pane in the session's directory", () => {
    const panes = [pane("w1:p1", "/work/app"), pane("w1:p2", "/work/other")]

    expect(claimTarget(caller("s-1", "/work/app"), on("w1:p1"), panes)).toBe("w1:p1")
    expect(claimTarget(caller("s-1", "/work/app"), on("w1:p2"), panes)).toBe("claude:s-1")
  })

  it("does not trust a pane that belongs to another session, a non-Claude pane or an unknown pane", () => {
    const panes = [pane("w1:p1", "/work/app", "claude", "s-2"), pane("w1:p3", "/work/app", "codex")]

    expect(claimTarget(caller("s-1", "/work/app"), on("w1:p1"), panes)).toBe("claude:s-1")
    expect(claimTarget(caller("s-1", "/work/app"), on("w1:p3"), panes)).toBe("claude:s-1")
    expect(claimTarget(caller("s-1", "/work/app"), on("w9:p9"), panes)).toBe("claude:s-1")
  })

  it("falls back to the session's inbox only when there is no pane at all", () => {
    expect(claimTarget(caller("s-1", "/work/app"), Option.none(), [])).toBe("claude:s-1")
  })

  it("writes one newline-terminated user message", () => {
    expect(JSON.parse(inboxLines(Text.make("hello")))).toEqual({ type: "user", message: { role: "user", content: "hello" } })
  })

  it.live("delivers through a session's pane when one holds it, and to its inbox socket only when none does", () =>
    Effect.gen(function* () {
      const config = mkdtempSync(join(tmpdir(), "prwatch-claude-"))
      const socketPath = join(config, "inbox.sock")
      const received: string[] = []
      const server = createServer((connection) => connection.on("data", (chunk) => received.push(chunk.toString())))
      yield* Effect.callback<void>((resume) => void server.listen(socketPath, () => resume(Effect.void)))
      yield* Effect.addFinalizer(() => Effect.sync(() => server.close()))
      mkdirSync(join(config, "sessions"))
      writeFileSync(join(config, "sessions", "123.json"), JSON.stringify({ pid: 123, sessionId: "s-1", messagingSocketPath: socketPath }))
      writeFileSync(join(config, "sessions", "124.json"), JSON.stringify({ pid: 124, sessionId: "s-2", messagingSocketPath: socketPath }))
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

      expect((yield* host.agents).map((agent) => agent.id)).toEqual(["w1:p1", "w1:p2", "claude:s-2", "claude:s-3"])

      yield* host.deliver(agentId("claude:s-1"), Text.make("review for the session in a pane"))
      yield* host.deliver(agentId("w1:p2"), Text.make("ci passed"))
      yield* host.deliver(agentId("claude:s-2"), Text.make("review for the session without a pane"))
      yield* Effect.sleep("50 millis")

      expect(terminalDeliveries).toEqual(["w1:p1", "w1:p2"])
      expect(received.join("")).toBe(inboxLines(Text.make("review for the session without a pane")))

      const missing = yield* Effect.flip(host.deliver(agentId("claude:s-3"), Text.make("x")))
      expect(missing.reason).toBe("the session has no inbox socket")
    }).pipe(Effect.scoped)
  )
})
