import { Config, Effect, Layer } from "effect"

import { DeliveryFailed, Host, HostUnavailable } from "../Host.ts"
import { agentId } from "../Ids.ts"
import { Shell } from "../Shell.ts"

const NAME = "tmux"

const AGENT_COMMANDS = ["claude", "codex", "opencode", "gemini", "pi", "amp", "aider", "cursor-agent"]

const FORMAT = "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{session_name}:#{window_index}"

const parsePane = (line: string) => {
  const [id = "", cwd = "", command = "", where = ""] = line.split("\t")
  return { id, cwd, command, where }
}

export const TmuxHost = Layer.effect(
  Host,
  Effect.gen(function* () {
    const shell = yield* Shell
    const extra = yield* Config.String("PRWATCH_AGENT_COMMANDS").pipe(Config.withDefault(""))
    const commands: ReadonlySet<string> = new Set([
      ...AGENT_COMMANDS,
      ...extra
        .split(",")
        .map((name) => name.trim())
        .filter((name) => name !== "")
    ])

    const agents = shell.run("tmux", ["list-panes", "-a", "-F", FORMAT]).pipe(
      Effect.map((out) =>
        out
          .split("\n")
          .filter((line) => line.trim() !== "")
          .map(parsePane)
          .filter((pane) => commands.has(pane.command))
          .map((pane) => ({
            id: agentId(pane.id),
            cwd: pane.cwd,
            label: `${pane.command} in ${pane.where}`,
            status: "unknown" as const
          }))
      ),
      Effect.mapError((error) => new HostUnavailable({ host: NAME, reason: error.message })),
      Effect.withSpan("TmuxHost.agents")
    )

    const deliver = Effect.fn("TmuxHost.deliver")(function* (agent: string, text: string) {
      const failed = (error: { readonly message: string }) => new DeliveryFailed({ host: NAME, agent, reason: error.message })
      const buffer = `prwatch-${agent.replace(/\W/g, "")}`

      yield* shell.run("tmux", ["load-buffer", "-b", buffer, "-"], { stdin: text }).pipe(Effect.mapError(failed))
      yield* shell.run("tmux", ["paste-buffer", "-p", "-d", "-b", buffer, "-t", agent]).pipe(Effect.mapError(failed))
      yield* shell.run("tmux", ["send-keys", "-t", agent, "Enter"]).pipe(Effect.mapError(failed))
    })

    const notify = Effect.fn("TmuxHost.notify")(function* (title: string, body: string) {
      yield* shell.run("tmux", ["display-message", `prwatch: ${title}: ${body.split("\n")[0] ?? ""}`]).pipe(Effect.ignore)
    })

    return Host.of({ name: NAME, agents, deliver, notify })
  })
)
