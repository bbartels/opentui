import { EventEmitter } from "events"
import { createCliRenderer, type CliRenderer, type CliRendererConfig } from "@opentui/core"
import type { ServerChannel } from "ssh2"
import { Readable, Writable } from "stream"
import type { PtyInfo, UserInfo } from "./types.ts"

export interface SSHSessionEvents {
  close: () => void
  resize: (width: number, height: number) => void
}

// Declaration merging for typed events
export interface SSHSession {
  on<K extends keyof SSHSessionEvents>(event: K, listener: SSHSessionEvents[K]): this
  once<K extends keyof SSHSessionEvents>(event: K, listener: SSHSessionEvents[K]): this
  off<K extends keyof SSHSessionEvents>(event: K, listener: SSHSessionEvents[K]): this
  emit<K extends keyof SSHSessionEvents>(event: K, ...args: Parameters<SSHSessionEvents[K]>): boolean
}

export class SSHSession extends EventEmitter {
  public readonly renderer: CliRenderer
  public readonly user: UserInfo
  public readonly remoteAddress: string

  private _pty: PtyInfo
  private _stream: ServerChannel
  private _closed = false

  public get pty(): Readonly<PtyInfo> {
    return this._pty
  }

  private constructor(
    renderer: CliRenderer,
    stream: ServerChannel,
    ptyInfo: PtyInfo,
    user: UserInfo,
    remoteAddress: string,
  ) {
    super()
    this.renderer = renderer
    this._stream = stream
    this._pty = { ...ptyInfo }
    this.user = user
    this.remoteAddress = remoteAddress
  }

  static async create(
    stream: ServerChannel,
    ptyInfo: PtyInfo,
    user: UserInfo,
    remoteAddress: string,
    rendererOptions: Partial<CliRendererConfig> = {},
  ): Promise<SSHSession> {
    // Create dummy streams for callback output mode.
    // These are NOT used for actual I/O - input comes via injectInput(),
    // output goes via onFlush callback. They exist as a "null object pattern" to:
    // 1. Provide terminal dimensions (stdout.columns, stdout.rows)
    // 2. Satisfy TypeScript types (NodeJS.ReadStream, NodeJS.WriteStream)
    // 3. Allow renderer code paths to work without null checks
    const dummyStdin = new Readable({
      read() {},
    }) as NodeJS.ReadStream
    Object.assign(dummyStdin, { isTTY: true, setRawMode: () => dummyStdin })

    const dummyStdout = new Writable({
      write(_chunk, _encoding, callback) {
        callback()
      },
    }) as NodeJS.WriteStream
    Object.assign(dummyStdout, {
      isTTY: true,
      columns: ptyInfo.width,
      rows: ptyInfo.height,
    })

    // Create placeholder for the session so we can reference it in onFlush
    let session: SSHSession | null = null

    const renderer = await createCliRenderer({
      ...rendererOptions,
      stdin: dummyStdin,
      stdout: dummyStdout,
      outputMode: "callback",
      useAlternateScreen: rendererOptions.useAlternateScreen ?? true,
      openConsoleOnError: false,
      useConsole: false,
      exitOnCtrlC: false,
      exitSignals: [],
      onFlush: (buffer: Uint8Array, done: () => void) => {
        // Guard: skip write if session is closed or stream is not writable
        if (session?._closed || !stream.writable) {
          return done()
        }
        // Zero-copy write to SSH stream:
        // Buffer.from(arrayBuffer, offset, length) creates a VIEW over the same memory,
        // NOT a copy. This was validated in Bun runtime - modifications to either the
        // original Uint8Array or the Buffer reflect in both.
        // The native buffer is stable during write because writeReady is false until done() is called.
        const out = Buffer.from(buffer.buffer, buffer.byteOffset, buffer.byteLength)
        // Wrap stream.write in try/catch to guarantee done() is called even on error
        try {
          stream.write(out, (err) => {
            if (err) {
              console.error(`[SSH] Stream write error: ${err.message}`)
            }
            done()
          })
        } catch (err) {
          // stream.write can throw synchronously if stream is destroyed
          console.error(`[SSH] Stream write threw: ${err instanceof Error ? err.message : String(err)}`)
          done()
        }
      },
    })

    session = new SSHSession(renderer, stream, ptyInfo, user, remoteAddress)

    // Wire SSH input -> renderer
    stream.on("data", (data: Buffer) => {
      if (!session!._closed) {
        renderer.injectInput(data)
      }
    })

    // Handle stream errors
    stream.on("error", (err: Error) => {
      console.error(`[SSH] Stream error: ${err.message}`)
      session!._cleanup()
    })

    // Wire cleanup on stream close
    stream.once("close", () => {
      session!._cleanup()
    })

    return session
  }

  /** Internal cleanup when stream closes/errors - idempotent */
  private _cleanup(): void {
    if (this._closed) return
    this._closed = true

    // Stop renderer and clean up asynchronously
    this.renderer.stop()
    this.renderer
      .idle()
      .then(() => {
        this.renderer.destroy()
        this.emit("close")
      })
      .catch((err) => {
        console.error(`[SSH] Error during session cleanup: ${err instanceof Error ? err.message : String(err)}`)
        // Still emit close event so listeners know the session is done
        this.emit("close")
      })
  }

  public handleResize(width: number, height: number): void {
    // Validate dimensions - reject invalid values from malicious/buggy clients
    if (width < 1 || height < 1 || width > 10000 || height > 10000) {
      return
    }
    this._pty.width = width
    this._pty.height = height
    this.renderer.resize(width, height)
    this.emit("resize", width, height)
  }

  public close(exitCode: number = 0): void {
    if (this._closed) return
    this._closed = true

    // Close the SSH stream FIRST (immediately) so the client sees the disconnect
    // This allows new connections to work without waiting for renderer cleanup
    this._stream.exit(exitCode)
    this._stream.end()

    // Then clean up the renderer asynchronously
    this.renderer.stop()
    this.renderer
      .idle()
      .then(() => {
        this.renderer.destroy()
        this.emit("close")
      })
      .catch((err) => {
        console.error(`[SSH] Error during session close: ${err instanceof Error ? err.message : String(err)}`)
        // Still emit close event so listeners know the session is done
        this.emit("close")
      })
  }
}
