import { Config, Effect, Layer } from "effect"

import { DeliveryFailed, Host, HostUnavailable } from "../Host.ts"
import { type AgentId, FilePath, Text, agentId } from "../Brands.ts"
import { type CommandFailed, Shell } from "../Shell.ts"

const NAME = "tmux" as const

const AGENT_COMMANDS = ["claude", "codex", "opencode", "gemini", "pi", "amp", "aider", "cursor-agent"]

const FORMAT = "#{pane_id}\t#{pane_current_path}\t#{pane_current_command}\t#{session_name}:#{window_index}"

export const TmuxHost = Layer.effect(
  Host,
  Effect.gen(function* () {
    const shell = yield* Shell
    const extra = yield* Config.String("PRWATCH_AGENT_COMMANDS").pipe(Config.withDefault(""))
    const commands = new Set([
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
          .map((line) => {
            const [id = "", cwd = "", command = "", where = ""] = line.split("\t")
            return { id, cwd, command, where }
          })
          .filter((pane) => commands.has(pane.command))
          .map((pane) => ({
            id: agentId(pane.id),
            cwd: FilePath.make(pane.cwd),
            label: Text.make(`${pane.command} in ${pane.where}`),
            status: "unknown" as const
          }))
      ),
      Effect.mapError((error) => new HostUnavailable({ host: NAME, reason: Text.make(error.message) })),
      Effect.withSpan("TmuxHost.agents")
    )

    const deliver = Effect.fn("TmuxHost.deliver")(function* (agent: AgentId, text: Text) {
      const failed = (error: CommandFailed) => new DeliveryFailed({ host: NAME, agent, reason: Text.make(error.message) })
      const buffer = `prwatch-${agent.replace(/\W/g, "")}`

      yield* shell.run("tmux", ["load-buffer", "-b", buffer, "-"], { stdin: text }).pipe(Effect.mapError(failed))
      yield* shell.run("tmux", ["paste-buffer", "-p", "-d", "-b", buffer, "-t", agent]).pipe(Effect.mapError(failed))
      yield* shell.run("tmux", ["send-keys", "-t", agent, "Enter"]).pipe(Effect.mapError(failed))
    })

    const notify = Effect.fn("TmuxHost.notify")(function* (title: Text, body: Text) {
      yield* shell.run("tmux", ["display-message", `prwatch: ${title}: ${body.split("\n")[0] ?? ""}`]).pipe(Effect.ignore)
    })

    return Host.of({ name: NAME, agents, deliver, notify })
  })
)
