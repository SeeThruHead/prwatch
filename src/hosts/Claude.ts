import { Config, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { createConnection } from "node:net"

import { type Agent, DeliveryFailed, Host } from "../Host.ts"
import { AgentId, FilePath, Text } from "../Brands.ts"
import { Shell } from "../Shell.ts"

const NAME = "claude" as const
const PREFIX = "claude:"
const SEND_TIMEOUT = "5 seconds"

const SessionId = Schema.NonEmptyString.pipe(Schema.brand("ClaudeSessionId"))
type SessionId = typeof SessionId.Type

const SessionState = Schema.String.pipe(Schema.brand("ClaudeSessionState"))

export const Listed = Schema.Struct({
  sessionId: SessionId,
  cwd: FilePath,
  name: Schema.optionalKey(Text),
  state: Schema.optionalKey(SessionState),
  status: Schema.optionalKey(SessionState)
})
type Listed = typeof Listed.Type

const Registered = Schema.Struct({ sessionId: SessionId, messagingSocketPath: Schema.optionalKey(FilePath) })

const statusOf = (state: typeof SessionState.Type | undefined) => {
  if (state === "idle") return "idle" as const
  if (state === "busy" || state === "working") return "working" as const
  if (state === "blocked") return "blocked" as const

  return "unknown" as const
}

const sessionAgentId = (session: SessionId) => AgentId.make(`${PREFIX}${session}`)

const isSessionAgent = (agent: AgentId) => agent.startsWith(PREFIX)

const sessionOf = (agent: AgentId) => SessionId.make(agent.slice(PREFIX.length))

export const agentsOf = (sessions: readonly Listed[]): readonly Agent[] =>
  sessions.map((session) => ({
    id: sessionAgentId(session.sessionId),
    cwd: session.cwd,
    program: Text.make("claude"),
    label: Text.make(`claude session "${session.name ?? session.sessionId}"`),
    status: statusOf(session.state ?? session.status)
  }))

export const preferSessions = (sessions: readonly Agent[], terminals: readonly Agent[]): readonly Agent[] => {
  const covered = new Set(sessions.map((session) => session.cwd))

  const duplicate = (terminal: Agent) => terminal.program === "claude" && covered.has(terminal.cwd)

  return [...sessions, ...terminals.filter((terminal) => !duplicate(terminal))]
}

export const inboxLines = (text: Text) => `${JSON.stringify({ type: "user", message: { role: "user", content: text } })}\n`

const sessionsDirectory = Effect.gen(function* () {
  const path = yield* Path.Path
  const home = yield* Config.String("HOME").pipe(Config.withDefault("."))
  const config = yield* Config.String("CLAUDE_CONFIG_DIR").pipe(Config.withDefault(path.join(home, ".claude")))

  return FilePath.make(path.join(config, "sessions"))
}).pipe(Effect.orDie)

const registeredSessions = Effect.fn("ClaudeSessions.registered")(function* (directory: FilePath) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const files = yield* fs.readDirectory(directory).pipe(
    Effect.map((names) => names.map((name) => FilePath.make(path.join(directory, name)))),
    Effect.orElseSucceed((): readonly FilePath[] => [])
  )
  const read = (file: FilePath) =>
    fs.readFileString(file).pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Registered))), Effect.option)

  const found = yield* Effect.forEach(
    files.filter((file) => file.endsWith(".json")),
    read,
    { concurrency: 8 }
  )

  return found.flatMap(Option.toArray)
})

export const callerSession = Effect.gen(function* () {
  const socket = yield* Config.String("CLAUDE_CODE_MESSAGING_SOCKET").pipe(Config.withDefault(""))
  if (socket === "") return Option.none<AgentId>()

  const sessions = yield* registeredSessions(yield* sessionsDirectory)
  return Option.map(Option.fromNullishOr(sessions.find((session) => session.messagingSocketPath === socket)), (session) =>
    sessionAgentId(session.sessionId)
  )
})

const post = (socketPath: FilePath, text: Text) =>
  Effect.callback<void, Error>((resume) => {
    const connection = createConnection(socketPath)
    connection.once("error", (error) => resume(Effect.fail(error)))
    connection.once("connect", () => connection.end(inboxLines(text), () => resume(Effect.void)))

    return Effect.sync(() => connection.destroy())
  }).pipe(Effect.timeout(SEND_TIMEOUT))

export const withClaudeSessions = <E, R>(terminal: Layer.Layer<Host, E, R>) =>
  Layer.effect(
    Host,
    Effect.gen(function* () {
      const fallback = yield* Effect.provide(
        Effect.gen(function* () {
          return yield* Host
        }),
        terminal
      )
      const shell = yield* Shell
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const directory = yield* sessionsDirectory

      const sessions = shell.run("claude", ["agents", "--json"]).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(Listed)))),
        Effect.map(agentsOf),
        Effect.orElseSucceed((): readonly Agent[] => []),
        Effect.withSpan("ClaudeSessions.agents")
      )

      const agents = Effect.gen(function* () {
        const live = yield* sessions
        const terminals = yield* fallback.agents.pipe(
          Effect.catchTag("HostUnavailable", (error) => (live.length > 0 ? Effect.succeed([]) : Effect.fail(error)))
        )

        return preferSessions(live, terminals)
      })

      const failed = (agent: AgentId, reason: Text) => new DeliveryFailed({ host: NAME, agent, reason })

      const deliverToSession = Effect.fn("ClaudeSessions.deliver")(function* (agent: AgentId, text: Text) {
        const session = sessionOf(agent)
        const registered = yield* registeredSessions(directory).pipe(
          Effect.provideService(FileSystem.FileSystem, fs),
          Effect.provideService(Path.Path, path)
        )
        const socketPath = registered.find((entry) => entry.sessionId === session)?.messagingSocketPath
        if (socketPath === undefined) return yield* failed(agent, Text.make("the session has no inbox socket"))

        yield* post(socketPath, text).pipe(Effect.mapError((error) => failed(agent, Text.make(error.message))))
      })

      const deliver = (agent: AgentId, text: Text) =>
        isSessionAgent(agent) ? deliverToSession(agent, text) : fallback.deliver(agent, text)

      return Host.of({ name: fallback.name, agents, deliver, notify: fallback.notify })
    })
  )
