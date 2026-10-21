import { NodeRuntime, NodeServices } from "@effect/platform-node"
import { Console, Effect, FileSystem, Schema } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

const tools = "claude|anthropic|copilot|openai|codex|chatgpt|gpt-|gemini|cursor|devin|aider|\\[bot\\]"

const patterns: ReadonlyArray<RegExp> = [
  new RegExp(`co-authored-by:.*(${tools})`, "i"),
  new RegExp(`generated (with|by|using) .*(${tools}|\\bai\\b)`, "i"),
  /noreply@anthropic\.com/i,
  /\u{1F916}/u
]

export type Finding = { readonly where: string; readonly line: number; readonly text: string }

export const findAttribution = (where: string, text: string): ReadonlyArray<Finding> =>
  text
    .split("\n")
    .map((line, index) => ({ where, line: index + 1, text: line.trim() }))
    .filter((entry) => !entry.text.startsWith("#"))
    .filter((entry) => patterns.some((pattern) => pattern.test(entry.text)))

export class AttributionFound extends Schema.TaggedError<AttributionFound>()("AttributionFound", {
  findings: Schema.Array(Schema.Struct({ where: Schema.String, line: Schema.Number, text: Schema.String }))
}) {}

const exempt = new Set(["tools/attribution.ts", "test/Attribution.test.ts"])

export const scanRepository = Effect.fn("Attribution.scanRepository")(function* () {
  const fs = yield* FileSystem.FileSystem
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

  const tracked = (yield* spawner.lines(ChildProcess.make("git", ["ls-files"]))).filter((file) => !exempt.has(file))
  const fileFindings = yield* Effect.forEach(tracked, (file) =>
    fs.readFileString(file).pipe(
      Effect.map((text) => findAttribution(file, text)),
      Effect.orElseSucceed((): ReadonlyArray<Finding> => [])
    )
  )
  const history = yield* spawner
    .string(ChildProcess.make("git", ["log", "--format=%H%n%an <%ae>%n%B%n---"]))
    .pipe(Effect.orElseSucceed(() => ""))

  return [...fileFindings.flat(), ...findAttribution("git history", history)]
})

export const checkMessage = Effect.fn("Attribution.checkMessage")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem
  const findings = findAttribution("commit message", yield* fs.readFileString(file))

  if (findings.length > 0) return yield* new AttributionFound({ findings })
})

const report = (error: AttributionFound) =>
  Console.error(
    [
      "AI attribution is not allowed in this repository:",
      ...error.findings.map((finding) => `  ${finding.where}:${finding.line}  ${finding.text}`)
    ].join("\n")
  )

const main = Effect.gen(function* () {
  const message = process.argv[2]
  if (message) return yield* checkMessage(message)

  const findings = yield* scanRepository()
  if (findings.length > 0) return yield* new AttributionFound({ findings })
}).pipe(Effect.tapError((error) => (error._tag === "AttributionFound" ? report(error) : Effect.void)))

if (import.meta.main) main.pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain({ disableErrorReporting: true }))
