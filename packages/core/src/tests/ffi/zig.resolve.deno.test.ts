/// <reference lib="deno.ns" />

const denoRuntime = (
  globalThis as {
    Deno?: {
      test?: (...args: any[]) => void
      build: { os: string; arch: string }
    }
  }
).Deno

function assertEquals(actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`Assertion failed. Expected ${String(expected)}, got ${String(actual)}`)
  }
}

async function loadZig() {
  const zigModulePath = new URL("../../zig.ts", import.meta.url).href
  const mod = (await import(zigModulePath)) as {
    resolveRenderLib: () => any
    setRenderLibPath: (path: string) => void
  }

  return mod
}

denoRuntime?.test?.({
  name: "resolveRenderLib loads native library in deno via default resolution",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { resolveRenderLib } = await loadZig()
    const lib = resolveRenderLib()
    const stream = lib.createNativeSpanFeed()

    const status = lib.streamClose(stream)
    assertEquals(status, 0)

    lib.destroyNativeSpanFeed(stream)
  },
})

denoRuntime?.test?.({
  name: "resolveRenderLib loads native library in deno via explicit path override",
  sanitizeResources: false,
  sanitizeOps: false,
  fn: async () => {
    const { resolveRenderLib, setRenderLibPath } = await loadZig()
    const deno = denoRuntime as { build: { os: string; arch: string } }
    const os = deno.build.os === "windows" ? "win32" : deno.build.os
    const arch = deno.build.arch === "x86_64" ? "x64" : deno.build.arch === "aarch64" ? "arm64" : deno.build.arch
    const libFile = os === "darwin" ? "libopentui.dylib" : os === "win32" ? "opentui.dll" : "libopentui.so"

    const libPath = decodeURIComponent(
      new URL(`../../../node_modules/@opentui/core-${os}-${arch}/${libFile}`, import.meta.url).pathname,
    )

    setRenderLibPath(libPath)

    const lib = resolveRenderLib()
    const stream = lib.createNativeSpanFeed({ chunkSize: 64, initialChunks: 1 })

    const status = lib.streamClose(stream)
    assertEquals(status, 0)

    lib.destroyNativeSpanFeed(stream)
  },
})
