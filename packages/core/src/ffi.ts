import { detectFfiRuntime, getBunGlobal, getDenoGlobal, type RuntimeKind } from "./runtime"

export type Pointer = number | bigint

export type NativeType =
  | "void"
  | "bool"
  | "u8"
  | "i8"
  | "u16"
  | "i16"
  | "u32"
  | "i32"
  | "u64"
  | "i64"
  | "f32"
  | "f64"
  | "ptr"
  | "pointer"
  | "buffer"
  | "usize"

type CompatSymbolDefinition = {
  args?: NativeType[]
  parameters?: NativeType[]
  returns?: NativeType
  result?: NativeType
  nonblocking?: boolean
}

export type CompatSymbolDefinitions = Record<string, CompatSymbolDefinition>

type CallbackSignature = {
  args: NativeType[]
  returns: NativeType
}

type BunCallbackHandle = {
  ptr: number | bigint
  close?: () => void
}

type DenoCallbackHandle = {
  pointer: number | bigint
  close: () => void
}

export class JSCallback {
  public readonly ptr: Pointer
  private readonly bunHandle?: BunCallbackHandle
  private readonly denoHandle?: DenoCallbackHandle

  constructor(fn: (...args: any[]) => any, signature: CallbackSignature) {
    const runtime = detectFfiRuntime()

    if (runtime === "bun") {
      const ffi = getBunFFI()
      const handle = ffi.callback
        ? ffi.callback(toBunSignature(signature), fn)
        : new ffi.JSCallback(fn, toBunSignature(signature))
      this.bunHandle = handle
      this.ptr = toPointer(handle.ptr)
      return
    }

    const deno = getDenoFFI()
    const handle = new deno.UnsafeCallback(toDenoSignature(signature), fn)
    this.denoHandle = handle
    this.ptr = toPointer(handle.pointer)
  }

  close(): void {
    if (this.bunHandle) {
      if (this.bunHandle.close) {
        this.bunHandle.close()
      } else {
        getBunFFI().closeCallback?.(this.bunHandle)
      }
      return
    }

    this.denoHandle?.close()
  }
}

export function dlopen(
  path: string,
  symbols: CompatSymbolDefinitions,
): {
  symbols: Record<string, any>
  close: () => void
} {
  const runtime = detectRuntime()

  if (runtime === "bun") {
    const ffi = getBunFFI()
    return ffi.dlopen(path, normalizeSymbolsForRuntime(symbols, runtime))
  }

  const deno = getDenoFFI()
  const lib = deno.dlopen(path, normalizeSymbolsForRuntime(symbols, runtime))
  return {
    symbols: lib.symbols as Record<string, any>,
    close: () => lib.close(),
  }
}

export function ptr(value: ArrayBuffer | ArrayBufferView): Pointer {
  const runtime = detectRuntime()

  if (runtime === "bun") {
    return toPointer(getBunFFI().ptr(value))
  }

  const deno = getDenoFFI()
  const view = toDenoBufferView(value)
  const pointer = deno.UnsafePointer.of(view)
  if (!pointer) {
    throw new Error("Failed to get pointer for buffer")
  }
  return toPointer(pointer)
}

export function toArrayBuffer(pointer: Pointer, byteOffset = 0, byteLength?: number): ArrayBuffer {
  const runtime = detectRuntime()

  if (runtime === "bun") {
    return getBunFFI().toArrayBuffer(pointer, byteOffset, byteLength)
  }

  const deno = getDenoFFI()
  let targetPointer: number | bigint = pointer
  if (byteOffset > 0 && deno.UnsafePointer.offset) {
    targetPointer = deno.UnsafePointer.offset(pointer, byteOffset)
  }

  const view = new deno.UnsafePointerView(targetPointer)
  const length = byteLength ?? 0
  return view.getArrayBuffer(length)
}

function toPointer(value: number | bigint | null): Pointer {
  if (value === null) {
    throw new Error("Received null pointer")
  }

  return value
}

function detectRuntime(): RuntimeKind {
  return detectFfiRuntime()
}

export function normalizeSymbolsForRuntime(
  symbols: CompatSymbolDefinitions,
  runtime: RuntimeKind,
): Record<string, any> {
  return runtime === "bun" ? toBunSymbols(symbols) : toDenoSymbols(symbols)
}

function normalizeSymbol(symbol: CompatSymbolDefinition): {
  args: NativeType[]
  returns: NativeType
  nonblocking?: boolean
} {
  const args = symbol.parameters ?? symbol.args ?? []
  const returns = symbol.result ?? symbol.returns ?? "void"

  return {
    args,
    returns,
    nonblocking: symbol.nonblocking,
  }
}

function toBunSignature(signature: CallbackSignature): { args: NativeType[]; returns: NativeType } {
  return {
    args: signature.args,
    returns: signature.returns,
  }
}

function toDenoSignature(signature: CallbackSignature): { parameters: string[]; result: string } {
  return {
    parameters: signature.args.map(toDenoType),
    result: toDenoType(signature.returns),
  }
}

function toBunSymbols(
  symbols: CompatSymbolDefinitions,
): Record<string, { args: NativeType[]; returns: NativeType; nonblocking?: boolean }> {
  const out: Record<string, { args: NativeType[]; returns: NativeType; nonblocking?: boolean }> = {}

  for (const [name, symbol] of Object.entries(symbols)) {
    out[name] = normalizeSymbol(symbol)
  }

  return out
}

function toDenoSymbols(
  symbols: CompatSymbolDefinitions,
): Record<string, { parameters: string[]; result: string; nonblocking?: boolean }> {
  const out: Record<string, { parameters: string[]; result: string; nonblocking?: boolean }> = {}

  for (const [name, symbol] of Object.entries(symbols)) {
    const normalized = normalizeSymbol(symbol)
    out[name] = {
      parameters: normalized.args.map(toDenoType),
      result: toDenoType(normalized.returns),
      nonblocking: normalized.nonblocking,
    }
  }

  return out
}

function toDenoType(type: NativeType): string {
  if (type === "ptr") {
    return "pointer"
  }

  return type
}

function getBunFFI(): {
  JSCallback: new (
    fn: (...args: any[]) => any,
    definition: { args: NativeType[]; returns: NativeType },
  ) => BunCallbackHandle
  callback?: (definition: { args: NativeType[]; returns: NativeType }, fn: (...args: any[]) => any) => BunCallbackHandle
  closeCallback?: (handle: BunCallbackHandle) => void
  dlopen: (path: string, symbols: Record<string, any>) => { symbols: Record<string, any>; close: () => void }
  ptr: (value: ArrayBuffer | ArrayBufferView) => number | bigint
  toArrayBuffer: (pointer: number | bigint, byteOffset?: number, byteLength?: number) => ArrayBuffer
} {
  const bun = getBunGlobal() as { FFI?: any } | undefined
  const bunFFI = bunFFIModule

  if (bunFFI) {
    return {
      JSCallback: bunFFI.JSCallback,
      callback: bun?.FFI?.callback,
      closeCallback: bun?.FFI?.closeCallback,
      dlopen: bunFFI.dlopen,
      ptr: bunFFI.ptr,
      toArrayBuffer: bunFFI.toArrayBuffer,
    }
  }

  if (!bun?.FFI) {
    throw new Error("Bun FFI runtime not available")
  }

  return {
    JSCallback: bun.FFI.JSCallback,
    callback: bun.FFI.callback,
    closeCallback: bun.FFI.closeCallback,
    dlopen: bun.FFI.dlopen,
    ptr: bun.FFI.ptr,
    toArrayBuffer: bun.FFI.toArrayBuffer,
  }
}

const bunFFIModule = getBunGlobal()?.FFI ? await import("bun:ffi") : null
// Keep one stable view per ArrayBuffer for Deno pointer extraction.
const denoArrayBufferViews = new WeakMap<ArrayBuffer, Uint8Array>()

function getDenoFFI(): {
  dlopen: (path: string, symbols: Record<string, any>) => { symbols: Record<string, any>; close: () => void }
  UnsafePointer: {
    of: (value: ArrayBufferView) => number | bigint | null
    offset?: (pointer: number | bigint, offset: number) => number | bigint
  }
  UnsafePointerView: new (pointer: number | bigint) => { getArrayBuffer: (byteLength: number) => ArrayBuffer }
  UnsafeCallback: new (
    definition: { parameters: string[]; result: string },
    fn: (...args: any[]) => any,
  ) => DenoCallbackHandle
} {
  const deno = getDenoGlobal() as any
  if (!deno?.dlopen || !deno?.UnsafePointer || !deno?.UnsafePointerView || !deno?.UnsafeCallback) {
    throw new Error("Deno FFI runtime not available")
  }

  return deno
}

function toDenoBufferView(value: ArrayBuffer | ArrayBufferView): ArrayBufferView {
  if (!(value instanceof ArrayBuffer)) {
    return value
  }

  const existing = denoArrayBufferViews.get(value)
  if (existing) {
    return existing
  }

  const view = new Uint8Array(value)
  denoArrayBufferViews.set(value, view)
  return view
}
