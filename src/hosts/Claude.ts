import { Config, Effect, FileSystem, Layer, Option, Path, Schema } from "effect"
import { createConnection } from "node:net"

import { type Agent, DeliveryFailed, Host } from "../Host.ts"
import { AgentId, FilePath, Text } from "../Brands.ts"
import { type SocketOrder } from "../Delivery.ts"
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

const Registered = Schema.Struct({
  sessionId: SessionId,
  cwd: Schema.optionalKey(FilePath),
  messagingSocketPath: Schema.optionalKey(FilePath)
})

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

const isClaudePane = (terminal: Agent) => terminal.program?.startsWith("claude") ?? false

const holdsSession = (session: AgentId) => (terminal: Agent) => isClaudePane(terminal) && terminal.session === Text.make(sessionOf(session))

const soleClaudePaneAt = (session: Agent, sessions: readonly Agent[], terminals: readonly Agent[]) => {
  const here = (agent: Agent) => agent.cwd === session.cwd
  const unknown = terminals.filter((terminal) => isClaudePane(terminal) && terminal.session === undefined && here(terminal))

  return unknown.length === 1 && sessions.filter(here).length === 1 ? unknown[0] : undefined
}

type Pairing = { readonly session: Agent; readonly pane: Agent | undefined }

const pairings = (sessions: readonly Agent[], terminals: readonly Agent[]): readonly Pairing[] =>
  sessions.map((session) => ({
    session,
    pane: terminals.find(holdsSession(session.id)) ?? soleClaudePaneAt(session, sessions, terminals)
  }))

export const preferPanes = (sessions: readonly Agent[], terminals: readonly Agent[]): readonly Agent[] => {
  const holders = pairings(sessions, terminals)
  const withSessions = (terminal: Agent) => {
    const held = holders.filter((holder) => holder.pane === terminal).map((holder) => holder.session.id)
    return held.length === 0 ? terminal : { ...terminal, aliases: [...(terminal.aliases ?? []), ...held] }
  }

  return [...terminals.map(withSessions), ...holders.filter((holder) => holder.pane === undefined).map((holder) => holder.session)]
}

export const preferSessions = (sessions: readonly Agent[], terminals: readonly Agent[]): readonly Agent[] => {
  const holders = pairings(sessions, terminals)
  const withPanes = (holder: Pairing) =>
    holder.pane === undefined ? holder.session : { ...holder.session, aliases: [...(holder.session.aliases ?? []), holder.pane.id] }
  const replaced = new Set(holders.flatMap((holder) => (holder.pane === undefined ? [] : [holder.pane])))

  return [...holders.map(withPanes), ...terminals.filter((terminal) => !replaced.has(terminal))]
}

export type Caller = { readonly agent: AgentId; readonly cwd: Option.Option<FilePath> }

const isThisPane = (caller: Caller, pane: AgentId) => (terminal: Agent) => {
  if (terminal.id !== pane) return false
  if (!isClaudePane(terminal)) return false
  if (terminal.session !== undefined) return false

  return Option.match(caller.cwd, { onNone: () => true, onSome: (cwd) => cwd === terminal.cwd })
}

export const claimTarget = (
  caller: Caller,
  pane: Option.Option<AgentId>,
  terminals: readonly Agent[],
  socket: SocketOrder
): Option.Option<AgentId> => {
  if (socket === "first") return Option.some(caller.agent)

  const holding = terminals.find(holdsSession(caller.agent))
  const own = Option.flatMap(pane, (id) => Option.fromNullishOr(terminals.find(isThisPane(caller, id))))
  const inPane = Option.map(
    Option.orElse(Option.fromNullishOr(holding), () => own),
    (terminal) => terminal.id
  )

  return socket === "last" ? Option.orElse(inPane, () => Option.some(caller.agent)) : inPane
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
  if (socket === "") return Option.none<Caller>()

  const sessions = yield* registeredSessions(yield* sessionsDirectory)
  return Option.map(Option.fromNullishOr(sessions.find((session) => session.messagingSocketPath === socket)), (session): Caller => ({
    agent: sessionAgentId(session.sessionId),
    cwd: Option.fromNullishOr(session.cwd)
  }))
})

const post = (socketPath: FilePath, text: Text) =>
  Effect.callback<void, Error>((resume) => {
    const connection = createConnection(socketPath)
    connection.once("error", (error) => resume(Effect.fail(error)))
    connection.once("connect", () => connection.end(inboxLines(text), () => resume(Effect.void)))

    return Effect.sync(() => connection.destroy())
  }).pipe(Effect.timeout(SEND_TIMEOUT))

export const withClaudeSessions = <E, R>(terminal: Layer.Layer<Host, E, R>, socket: Exclude<SocketOrder, "off">) =>
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

        return socket === "last" ? preferPanes(live, terminals) : preferSessions(live, terminals)
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

      const paneHolding = (session: AgentId) =>
        agents.pipe(
          Effect.map((found) => found.find((candidate) => candidate.aliases?.includes(session))),
          Effect.orElseSucceed(() => undefined)
        )

      const deliverToSessionOrItsPane = Effect.fn("ClaudeSessions.deliverToSessionOrItsPane")(function* (agent: AgentId, text: Text) {
        const pane = yield* paneHolding(agent)
        if (pane === undefined) return yield* deliverToSession(agent, text)

        yield* fallback.deliver(pane.id, text)
      })

      const deliver = (agent: AgentId, text: Text) =>
        isSessionAgent(agent) ? deliverToSessionOrItsPane(agent, text) : fallback.deliver(agent, text)

      return Host.of({ name: fallback.name, agents, deliver, notify: fallback.notify })
    })
  )
