export type RuntimeKind = "bun" | "deno"

type BunGlobal = {
  FFI?: unknown
  platform?: string
  stringWidth?: (value: string) => number
  sleep?: (ms: number) => Promise<void>
  file?: (path: string) => unknown
  serve?: (options: RuntimeServeOptions) => RuntimeServer
  stripANSI?: (value: string) => string
}

type DenoGlobal = {
  dlopen?: unknown
  env?: {
    get?: (key: string) => string | undefined
  }
  build?: {
    os?: string
    arch?: string
  }
  readFileSync?: (path: string) => Uint8Array
  serve?: (
    options: { port: number },
    handler: (request: Request) => Response | Promise<Response>,
  ) => { shutdown: () => Promise<void> }
}

export type RuntimeServeOptions = {
  port: number
  fetch: (request: Request) => Response | Promise<Response>
}

export type RuntimeServer = {
  stop: () => void
}

type ProcessGlobal = {
  env?: Record<string, string | undefined>
  platform?: string
  arch?: string
  on?: (event: string, handler: () => void) => void
}

export function getBunGlobal(): BunGlobal | undefined {
  return (globalThis as { Bun?: BunGlobal }).Bun
}

export function getDenoGlobal(): DenoGlobal | undefined {
  return (globalThis as { Deno?: DenoGlobal }).Deno
}

export function getProcessGlobal(): ProcessGlobal | undefined {
  return (globalThis as { process?: ProcessGlobal }).process
}

export function detectFfiRuntime(): RuntimeKind {
  if (getBunGlobal()?.FFI) {
    return "bun"
  }

  if (getDenoGlobal()?.dlopen) {
    return "deno"
  }

  throw new Error("Unsupported runtime. Expected Bun or Deno.")
}

export function isDenoRuntime(): boolean {
  return getDenoGlobal() !== undefined
}

export function getRuntimePlatformArch(): { platform: string; arch: string } {
  const proc = getProcessGlobal()
  if (proc?.platform && proc?.arch) {
    return {
      platform: normalizePlatform(proc.platform),
      arch: normalizeArch(proc.arch),
    }
  }

  const deno = getDenoGlobal()
  if (deno?.build?.os && deno?.build?.arch) {
    return {
      platform: normalizePlatform(deno.build.os),
      arch: normalizeArch(deno.build.arch),
    }
  }

  throw new Error("Unable to determine runtime platform and architecture.")
}

export function getProcessEnv(): Record<string, string | undefined> | undefined {
  try {
    return getProcessGlobal()?.env
  } catch (error) {
    if (isPermissionDeniedError(error)) {
      return undefined
    }

    throw error
  }
}

export function getDenoEnvGet(): ((key: string) => string | undefined) | undefined {
  return getDenoGlobal()?.env?.get
}

export function getProcessOn(): ((event: string, handler: () => void) => void) | undefined {
  return getProcessGlobal()?.on
}

export function stringWidth(value: string): number {
  const bunStringWidth = getBunGlobal()?.stringWidth
  if (bunStringWidth) {
    return bunStringWidth(value)
  }

  return [...value].length
}

export async function sleep(ms: number): Promise<void> {
  const bunSleep = getBunGlobal()?.sleep
  if (bunSleep) {
    await bunSleep(ms)
    return
  }

  await new Promise((resolve) => setTimeout(resolve, ms))
}

export function file(path: string): unknown {
  const bunFile = getBunGlobal()?.file
  if (bunFile) {
    return bunFile(path)
  }

  const denoReadFileSync = getDenoGlobal()?.readFileSync
  if (denoReadFileSync) {
    const bytes = denoReadFileSync(path)
    const arrayBuffer = new ArrayBuffer(bytes.byteLength)
    new Uint8Array(arrayBuffer).set(bytes)
    return new Blob([arrayBuffer])
  }

  throw new Error("Runtime does not support file().")
}

export function serve(options: RuntimeServeOptions): RuntimeServer {
  const bunServe = getBunGlobal()?.serve
  if (bunServe) {
    return bunServe(options)
  }

  const denoServe = getDenoGlobal()?.serve
  if (!denoServe) {
    throw new Error("Runtime does not support serve().")
  }

  const server = denoServe({ port: options.port }, options.fetch)
  return {
    stop() {
      void server.shutdown()
    },
  }
}

export function stripANSI(value: string): string {
  const bunStripAnsi = getBunGlobal()?.stripANSI
  if (bunStripAnsi) {
    return bunStripAnsi(value)
  }

  return value.replace(ANSI_PATTERN, "")
}

function normalizePlatform(platform: string): string {
  if (platform === "windows") {
    return "win32"
  }

  return platform
}

function normalizeArch(arch: string): string {
  if (arch === "x86_64") {
    return "x64"
  }

  if (arch === "aarch64") {
    return "arm64"
  }

  return arch
}

function isPermissionDeniedError(error: unknown): boolean {
  return error instanceof Error && error.name === "PermissionDenied"
}

const ANSI_PATTERN =
  /[\u001B\u009B][[\]()#;?]*(?:(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~])|(?:[^\u0007]*(?:\u0007|\u001B\\)))/g
