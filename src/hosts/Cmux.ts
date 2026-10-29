import { Effect, Layer, Schema } from "effect"

import { DeliveryFailed, Host, HostUnavailable } from "../Host.ts"
import { AgentId, FilePath, type Stdout, Text } from "../Brands.ts"
import { type CommandFailed, Shell } from "../Shell.ts"

const NAME = "cmux" as const

const AGENT_STATUS_KEYS = ["claude_code", "codex", "opencode", "gemini"] as const

const SidebarValue = Schema.String.pipe(Schema.brand("SidebarValue"))
type SidebarValue = typeof SidebarValue.Type

const CmuxWorkspace = Schema.Struct({ id: AgentId, title: Text })

const Workspaces = Schema.Struct({
  workspaces: Schema.Array(CmuxWorkspace)
})

export const fields = (text: Stdout) =>
  new Map(
    text
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const at = line.indexOf("=")
        return at <= 0 ? [] : [[line.slice(0, at), SidebarValue.make(line.slice(at + 1))] as const]
      })
  )

const PASTE_START = "\u001b[200~"
const PASTE_END = "\u001b[201~"

export const bracketed = (text: Text) => `${PASTE_START}${text}${PASTE_END}`

const statusOf = (value: SidebarValue) => {
  const state = value.split(" ")[0] ?? ""
  if (state === "Running") return "working" as const
  if (state === "Idle") return "idle" as const

  return "blocked" as const
}

export const agentStatus = (sidebar: ReturnType<typeof fields>) =>
  AGENT_STATUS_KEYS.flatMap((key) => {
    const value = sidebar.get(key)
    return value === undefined ? [] : [{ key, status: statusOf(value) }]
  })[0]

export const CmuxHost = Layer.effect(
  Host,
  Effect.gen(function* () {
    const shell = yield* Shell

    const cmux = (args: Parameters<typeof shell.run>[1]) => shell.run("cmux", args)

    const describe = Effect.fnUntraced(function* (workspace: typeof CmuxWorkspace.Type) {
      const sidebar = fields(yield* cmux(["sidebar-state", "--workspace", workspace.id]))
      const agent = agentStatus(sidebar)
      const cwd = sidebar.get("focused_cwd") ?? sidebar.get("cwd")
      if (agent === undefined || cwd === undefined) return []

      return [
        { id: workspace.id, cwd: FilePath.make(cwd), label: Text.make(`${agent.key} in cmux "${workspace.title}"`), status: agent.status }
      ]
    })

    const agents = cmux(["--json", "--id-format", "uuids", "list-workspaces"]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Workspaces))),
      Effect.flatMap(({ workspaces }) => Effect.forEach(workspaces, describe, { concurrency: 4 })),
      Effect.map((found) => found.flat()),
      Effect.mapError((error) => new HostUnavailable({ host: NAME, reason: Text.make(error.message) })),
      Effect.withSpan("CmuxHost.agents")
    )

    const deliver = Effect.fn("CmuxHost.deliver")(function* (agent: AgentId, text: Text) {
      const failed = (error: CommandFailed) => new DeliveryFailed({ host: NAME, agent, reason: Text.make(error.message) })
      const buffer = `prwatch-${agent.replace(/\W/g, "")}`

      yield* cmux(["set-buffer", "--name", buffer, bracketed(text)]).pipe(Effect.mapError(failed))
      yield* cmux(["paste-buffer", "--name", buffer, "--workspace", agent]).pipe(Effect.mapError(failed))
      yield* cmux(["send-key", "--workspace", agent, "enter"]).pipe(Effect.mapError(failed))
    })

    const notify = Effect.fn("CmuxHost.notify")(function* (title: Text, body: Text) {
      yield* cmux(["notify", "--title", title, "--body", body]).pipe(Effect.ignore)
    })

    return Host.of({ name: NAME, agents, deliver, notify })
  })
)
