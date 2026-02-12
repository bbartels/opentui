import { dlopen, ptr } from "bun:ffi"
import type { Pointer } from "bun:ffi"

const STD_INPUT_HANDLE = -10
const ENABLE_PROCESSED_INPUT = 0x0001

type Kernel32 = {
  symbols: {
    GetStdHandle: (nStdHandle: number) => Pointer
    GetConsoleMode: (handle: Pointer, mode: Pointer) => number
    SetConsoleMode: (handle: Pointer, mode: number) => number
    SetConsoleCtrlHandler: (handler: Pointer | null, add: number) => number
  }
}

export type Win32Console = {
  getMode: () => number | undefined
  setMode: (mode: number) => void
  setIgnoreCtrlC?: (ignore: boolean) => void
}

export type Scheduler = {
  setInterval: typeof setInterval
  clearInterval: typeof clearInterval
  setImmediate: typeof setImmediate
}

export type Win32ProcessedInputGuard = {
  enforce: () => void
  dispose: () => void
}

let kernel32: Kernel32 | undefined
let stdinConsole: Win32Console | undefined

function loadKernel32(): Kernel32 | undefined {
  if (kernel32) return kernel32
  try {
    kernel32 = dlopen("kernel32.dll", {
      GetStdHandle: { args: ["i32"], returns: "ptr" },
      GetConsoleMode: { args: ["ptr", "ptr"], returns: "i32" },
      SetConsoleMode: { args: ["ptr", "u32"], returns: "i32" },
      SetConsoleCtrlHandler: { args: ["ptr", "i32"], returns: "i32" },
    }) as unknown as Kernel32
    return kernel32
  } catch {
    return undefined
  }
}

export function createWin32StdinConsole(): Win32Console | undefined {
  if (process.platform !== "win32") return
  if (stdinConsole) return stdinConsole

  const k32 = loadKernel32()
  if (!k32) return

  const handle = k32.symbols.GetStdHandle(STD_INPUT_HANDLE)
  const buf = new Uint32Array(1)

  stdinConsole = {
    getMode: () => {
      if (k32.symbols.GetConsoleMode(handle, ptr(buf)) === 0) return
      return buf[0]
    },
    setMode: (mode: number) => {
      k32.symbols.SetConsoleMode(handle, mode)
    },
    setIgnoreCtrlC: (ignore: boolean) => {
      k32.symbols.SetConsoleCtrlHandler(null, ignore ? 1 : 0)
    },
  }

  return stdinConsole
}

export function installWin32ProcessedInputGuard(
  console: Win32Console,
  opts: { interval?: number; scheduler?: Scheduler } = {},
): Win32ProcessedInputGuard {
  const scheduler = opts.scheduler ?? {
    setInterval,
    clearInterval,
    setImmediate,
  }

  const enforce = () => {
    const mode = console.getMode()
    if (mode === undefined) return
    if ((mode & ENABLE_PROCESSED_INPUT) === 0) return
    console.setMode(mode & ~ENABLE_PROCESSED_INPUT)
  }

  const later = () => {
    enforce()
    scheduler.setImmediate(enforce)
  }

  console.setIgnoreCtrlC?.(true)
  later()
  const id = scheduler.setInterval(enforce, opts.interval ?? 100)

  return {
    enforce,
    dispose: () => {
      scheduler.clearInterval(id)
      console.setIgnoreCtrlC?.(false)
    },
  }
}
