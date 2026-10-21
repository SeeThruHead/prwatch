import { Effect, Layer, Schema } from "effect"

import { DeliveryFailed, Host, HostUnavailable } from "../Host.ts"
import { agentId } from "../Ids.ts"
import { Shell } from "../Shell.ts"

const NAME = "cmux"

const AGENT_STATUS_KEYS: readonly string[] = ["claude_code", "codex", "opencode", "gemini"]

const Workspaces = Schema.Struct({
  workspaces: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String }))
})

export const fields = (text: string): ReadonlyMap<string, string> =>
  new Map(
    text
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const at = line.indexOf("=")
        return at <= 0 ? [] : [[line.slice(0, at), line.slice(at + 1)] as const]
      })
  )

const PASTE_START = "\u001b[200~"
const PASTE_END = "\u001b[201~"

export const bracketed = (text: string) => `${PASTE_START}${text}${PASTE_END}`

export const statusOf = (value: string) => {
  const state = value.split(" ")[0] ?? ""
  if (state === "Running") return "working" as const
  if (state === "Idle") return "idle" as const

  return "blocked" as const
}

export const agentStatus = (sidebar: ReadonlyMap<string, string>) =>
  AGENT_STATUS_KEYS.flatMap((key) => {
    const value = sidebar.get(key)
    return value === undefined ? [] : [{ key, status: statusOf(value) }]
  })[0]

export const CmuxHost = Layer.effect(
  Host,
  Effect.gen(function* () {
    const shell = yield* Shell

    const cmux = (args: readonly string[], stdin?: string) => shell.run("cmux", args, stdin === undefined ? {} : { stdin })

    const describe = Effect.fnUntraced(function* (workspace: { readonly id: string; readonly title: string }) {
      const sidebar = fields(yield* cmux(["sidebar-state", "--workspace", workspace.id]))
      const agent = agentStatus(sidebar)
      const cwd = sidebar.get("focused_cwd") ?? sidebar.get("cwd")
      if (agent === undefined || cwd === undefined) return []

      return [{ id: agentId(workspace.id), cwd, label: `${agent.key} in cmux "${workspace.title}"`, status: agent.status }]
    })

    const agents = cmux(["--json", "--id-format", "uuids", "list-workspaces"]).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Workspaces))),
      Effect.flatMap(({ workspaces }) => Effect.forEach(workspaces, describe, { concurrency: 4 })),
      Effect.map((found) => found.flat()),
      Effect.mapError((error) => new HostUnavailable({ host: NAME, reason: error.message })),
      Effect.withSpan("CmuxHost.agents")
    )

    const deliver = Effect.fn("CmuxHost.deliver")(function* (agent: string, text: string) {
      const failed = (error: { readonly message: string }) => new DeliveryFailed({ host: NAME, agent, reason: error.message })
      const buffer = `prwatch-${agent.replace(/\W/g, "")}`

      yield* cmux(["set-buffer", "--name", buffer, bracketed(text)]).pipe(Effect.mapError(failed))
      yield* cmux(["paste-buffer", "--name", buffer, "--workspace", agent]).pipe(Effect.mapError(failed))
      yield* cmux(["send-key", "--workspace", agent, "enter"]).pipe(Effect.mapError(failed))
    })

    const notify = Effect.fn("CmuxHost.notify")(function* (title: string, body: string) {
      yield* cmux(["notify", "--title", title, "--body", body]).pipe(Effect.ignore)
    })

    return Host.of({ name: NAME, agents, deliver, notify })
  })
)
