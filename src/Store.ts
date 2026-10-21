import { Config, Context, Effect, FileSystem, Layer, Path, Schema } from "effect"

import { Seen } from "./Changes.ts"

export const Status = Schema.Struct({
  updatedAt: Schema.String,
  host: Schema.String,
  error: Schema.optionalKey(Schema.String),
  pulls: Schema.Array(
    Schema.Struct({
      key: Schema.String,
      title: Schema.String,
      url: Schema.String,
      needsYou: Schema.Boolean,
      last: Schema.optionalKey(Schema.String),
      lastAt: Schema.optionalKey(Schema.String),
      agent: Schema.optionalKey(Schema.String),
      agentId: Schema.optionalKey(Schema.String)
    })
  )
})
export type Status = typeof Status.Type

export const Claims = Schema.Record(Schema.String, Schema.Array(Schema.Struct({ agent: Schema.String, at: Schema.String })))
export type Claims = typeof Claims.Type

export class StoreUnwritable extends Schema.TaggedError<StoreUnwritable>()("StoreUnwritable", {
  path: Schema.String,
  reason: Schema.String
}) {
  override get message() {
    return `could not write ${this.path}: ${this.reason}`
  }
}

export class Store extends Context.Service<
  Store,
  {
    readonly home: string
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
      const home = yield* Config.String("PRWATCH_HOME").pipe(Config.withDefault(fallback))

      yield* fs.makeDirectory(home, { recursive: true }).pipe(Effect.orDie)

      const read = <S extends Schema.Top & { readonly DecodingServices: never }>(file: string, schema: S) =>
        fs.readFileString(path.join(home, file)).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(schema))),
          Effect.map((value): S["Type"] | undefined => value),
          Effect.orElseSucceed(() => undefined)
        )

      const write = <S extends Schema.Top & { readonly EncodingServices: never }>(file: string, schema: S, value: S["Type"]) => {
        const target = path.join(home, file)
        const temporary = `${target}.tmp`

        return Schema.encodeEffect(Schema.fromJsonString(schema))(value).pipe(
          Effect.flatMap((text) => fs.writeFileString(temporary, text)),
          Effect.andThen(fs.rename(temporary, target)),
          Effect.mapError((error) => new StoreUnwritable({ path: target, reason: error.message }))
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
