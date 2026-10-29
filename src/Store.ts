import { Config, Context, Effect, FileSystem, Layer, Path, Schema } from "effect"

import { AgentId, Count, FilePath, HostName, IsoTime, PrKey, ReviewDecision, Text, Url } from "./Brands.ts"
import { Seen } from "./Changes.ts"
import { Checks, Mergeable, Role } from "./GitHub.ts"

export const StatusPull = Schema.Struct({
  key: PrKey,
  title: Text,
  url: Url,
  needsYou: Schema.Boolean,
  last: Schema.optionalKey(Text),
  lastAt: Schema.optionalKey(IsoTime),
  agent: Schema.optionalKey(Text),
  agentId: Schema.optionalKey(AgentId),
  role: Schema.optionalKey(Role),
  draft: Schema.optionalKey(Schema.Boolean),
  checks: Schema.optionalKey(Checks),
  decision: Schema.optionalKey(Schema.NullOr(ReviewDecision)),
  mergeable: Schema.optionalKey(Mergeable),
  comments: Schema.optionalKey(Count)
})
export type StatusPull = typeof StatusPull.Type

export const Status = Schema.Struct({
  updatedAt: IsoTime,
  host: HostName,
  error: Schema.optionalKey(Text),
  pulls: Schema.Array(StatusPull)
})
export type Status = typeof Status.Type

export const Claims = Schema.Record(PrKey, Schema.Array(Schema.Struct({ agent: AgentId, at: IsoTime })))
export type Claims = typeof Claims.Type

export class StoreUnwritable extends Schema.TaggedError<StoreUnwritable>()("StoreUnwritable", {
  path: FilePath,
  reason: Text
}) {
  override get message() {
    return `could not write ${this.path}: ${this.reason}`
  }
}

type StoreFile = "seen.json" | "status.json" | "claims.json"

export class Store extends Context.Service<
  Store,
  {
    readonly home: FilePath
    readonly seen: Effect.Effect<Seen | undefined>
    readonly saveSeen: (seen: Seen) => Effect.Effect<void, StoreUnwritable>
    readonly status: Effect.Effect<Status | undefined>
    readonly saveStatus: (status: Status) => Effect.Effect<void, StoreUnwritable>
    readonly claims: Effect.Effect<Claims>
    readonly saveClaims: (claims: Claims) => Effect.Effect<void, StoreUnwritable>
  }
>()("prwatch/Store") {
  static readonly layer = Layer.effect(
    Store,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path
      const fallback = path.join(yield* Config.String("HOME").pipe(Config.withDefault(".")), ".prwatch")
      const home = FilePath.make(yield* Config.String("PRWATCH_HOME").pipe(Config.withDefault(fallback)))

      yield* fs.makeDirectory(home, { recursive: true }).pipe(Effect.orDie)

      const read = <S extends Schema.Top & { readonly DecodingServices: never }>(file: StoreFile, schema: S) =>
        fs.readFileString(path.join(home, file)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
          Effect.map((value): S["Type"] | undefined => value),
          Effect.orElseSucceed(() => undefined)
        )

      const write = <S extends Schema.Top & { readonly EncodingServices: never }>(file: StoreFile, schema: S, value: S["Type"]) => {
        const target = FilePath.make(path.join(home, file))
        const temporary = `${target}.tmp`

        return Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
          Effect.flatMap((text) => fs.writeFileString(temporary, text)),
          Effect.andThen(fs.rename(temporary, target)),
          Effect.mapError((error) => new StoreUnwritable({ path: target, reason: Text.make(error.message) }))
        )
      }

      return Store.of({
        home,
        seen: read("seen.json", Seen),
        saveSeen: (seen) => write("seen.json", Seen, seen),
        status: read("status.json", Status),
        saveStatus: (status) => write("status.json", Status, status),
        claims: Effect.map(read("claims.json", Claims), (claims) => claims ?? {}),
        saveClaims: (claims) => write("claims.json", Claims, claims)
      })
    })
  )
}
