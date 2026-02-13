export type RuntimeKind = "bun" | "deno"

type BunGlobal = {
  FFI?: unknown
  platform?: string
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
