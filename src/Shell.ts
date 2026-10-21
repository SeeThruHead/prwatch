import { Context, Effect, Layer, Schema, Stream } from "effect"
import { ChildProcess, ChildProcessSpawner } from "effect/process"

export class CommandFailed extends Schema.TaggedError<CommandFailed>()("CommandFailed", {
  command: Schema.String,
  exitCode: Schema.Number,
  stderr: Schema.String
}) {
  override get message() {
    const detail = this.stderr.trim().split("\n").slice(-3).join(" ")
    return `${this.command} exited ${this.exitCode}${detail === "" ? "" : `: ${detail}`}`
  }
}

const COMMAND_TIMEOUT = "30 seconds"

const encode = (text: string) => Stream.make(new TextEncoder().encode(text))

export class Shell extends Context.Service<
  Shell,
  {
    readonly run: (
      command: string,
      args: readonly string[],
      options?: { readonly cwd?: string; readonly stdin?: string }
    ) => Effect.Effect<string, CommandFailed>
  }
>()("prwatch/Shell") {
  static readonly layer = Layer.effect(
    Shell,
    Effect.gen(function* () {
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner

      const run = Effect.fn("Shell.run")(function* (
        command: string,
        args: readonly string[],
        options: { readonly cwd?: string; readonly stdin?: string } = {}
      ) {
        const label = [command, ...args.slice(0, 2)].join(" ")
        const failed = (exitCode: number, stderr: string) => new CommandFailed({ command: label, exitCode, stderr })

        return yield* Effect.scoped(
          Effect.gen(function* () {
            const handle = yield* spawner.spawn(
              ChildProcess.make(command, [...args], {
                ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
                ...(options.stdin === undefined ? {} : { stdin: { stream: encode(options.stdin) } })
              })
            )

            const [stdout, stderr, exitCode] = yield* Effect.all(
              [Stream.mkString(Stream.decodeText(handle.stdout)), Stream.mkString(Stream.decodeText(handle.stderr)), handle.exitCode],
              { concurrency: 3 }
            )

            return exitCode === 0 ? stdout : yield* failed(exitCode, stderr)
          })
        ).pipe(
          Effect.timeoutOrElse({ duration: COMMAND_TIMEOUT, orElse: () => Effect.fail(failed(-1, "timed out")) }),
          Effect.catchTag("PlatformError", (error) => Effect.fail(failed(-1, error.message)))
        )
      })

      return Shell.of({ run })
    })
  )
}
