import { hostname } from "node:os"

import { Config, Context, Effect, FileSystem, Layer, Path, Schema } from "effect"

import { FilePath, type Glob, Hostname, Text } from "./Brands.ts"
import { globsMatch, lastBy } from "./Fields.ts"
import { problems } from "./Matcher.ts"
import { DEFAULT_DELIVERY } from "./Delivery.ts"
import { type Delivery, type DeskConfig, type Rule, WatchRules } from "./Rules.ts"

export class RulesInvalid extends Schema.TaggedError<RulesInvalid>()("RulesInvalid", { reasons: Schema.Array(Text) }) {
  override get message() {
    return `watch rules are invalid: ${this.reasons.join("; ")}`
  }
}

export type Located = { readonly rule: Rule; readonly file: FilePath }

export const activeOn = (machine: Hostname) => (rules: readonly Located[]) =>
  rules.filter(({ rule }) => rule.machines === undefined || globsMatch(rule.machines, machine))

const FILES = ["config.json", "config.local.json"] as const

export class RulesConfig extends Context.Service<
  RulesConfig,
  {
    readonly dir: FilePath
    readonly machine: Hostname
    readonly files: readonly FilePath[]
    readonly load: Effect.Effect<readonly Located[], RulesInvalid>
    readonly delivery: Effect.Effect<Delivery, RulesInvalid>
    readonly desk: Effect.Effect<DeskConfig | undefined, RulesInvalid>
    readonly ignore: Effect.Effect<readonly Glob[], RulesInvalid>
  }
>()("prwatch/RulesConfig") {
  static readonly layer = Layer.effect(
    RulesConfig,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const home = yield* Config.String("HOME").pipe(Config.withDefault("."))
      const xdg = yield* Config.String("XDG_CONFIG_HOME").pipe(Config.withDefault(path.join(home, ".config")))
      const dir = FilePath.make(yield* Config.String("PRWATCH_CONFIG_DIR").pipe(Config.withDefault(path.join(xdg, "prwatch"))))
      const machine = Hostname.make(yield* Config.String("PRWATCH_MACHINE").pipe(Config.withDefault(hostname())))
      const files = FILES.map((name) => FilePath.make(path.join(dir, name)))

      const invalid = (file: FilePath) => (error: Error) => new RulesInvalid({ reasons: [Text.make(`${file}: ${error.message}`)] })

      const read = Effect.fn("RulesConfig.read")(function* (file: FilePath) {
        if (!(yield* fs.exists(file).pipe(Effect.mapError(invalid(file))))) return undefined

        const text = yield* fs.readFileString(file).pipe(Effect.mapError(invalid(file)))
        return yield* Schema.decodeUnknownEffect(Schema.fromJsonString(WatchRules))(text, { onExcessProperty: "error" }).pipe(
          Effect.mapError(invalid(file))
        )
      })

      const rulesIn = (file: FilePath) =>
        Effect.map(read(file), (decoded) => (decoded?.rules ?? []).map((rule): Located => ({ rule, file })))

      const merged = (lists: readonly (readonly Located[])[]) => lastBy(lists.flat(), (entry) => entry.rule.name)

      const load = Effect.gen(function* () {
        const located = merged(yield* Effect.forEach(files, rulesIn))
        const reasons = problems(located.map((entry) => entry.rule))
        if (reasons.length > 0) return yield* new RulesInvalid({ reasons })

        return located
      }).pipe(Effect.withSpan("RulesConfig.load"))

      const delivery = Effect.forEach(files, read).pipe(
        Effect.map((decoded) => decoded.findLast((entry) => entry?.delivery !== undefined)?.delivery ?? DEFAULT_DELIVERY),
        Effect.withSpan("RulesConfig.delivery")
      )

      const desk = Effect.forEach(files, read).pipe(
        Effect.map((decoded) => decoded.findLast((entry) => entry?.desk !== undefined)?.desk),
        Effect.withSpan("RulesConfig.desk")
      )

      const ignore = Effect.forEach(files, read).pipe(
        Effect.map((decoded): readonly Glob[] => decoded.findLast((entry) => entry?.ignore !== undefined)?.ignore ?? []),
        Effect.withSpan("RulesConfig.ignore")
      )

      return RulesConfig.of({ dir, machine, files, load, delivery, desk, ignore })
    })
  )
}
