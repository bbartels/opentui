import { detectFfiRuntime, getBunGlobal, getDenoGlobal, type RuntimeKind } from "./runtime"

export type Pointer = number | bigint | object

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
  pointer: number | bigint | object
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
    symbols: wrapDenoSymbols(lib.symbols as Record<string, any>, symbols),
    close: () => lib.close(),
  }
}

function wrapDenoSymbols(nativeSymbols: Record<string, any>, symbols: CompatSymbolDefinitions): Record<string, any> {
  const wrapped: Record<string, any> = {}
  const deno = getDenoFFI()

  for (const [name, nativeSymbol] of Object.entries(nativeSymbols)) {
    const definition = symbols[name]
    if (!definition) {
      wrapped[name] = nativeSymbol
      continue
    }

    const pointerIndices = getPointerParameterIndices(definition)
    if (pointerIndices.length === 0) {
      wrapped[name] = nativeSymbol
      continue
    }

    wrapped[name] = (...args: any[]) => {
      const convertedArgs = [...args]

      for (const pointerIndex of pointerIndices) {
        const value = convertedArgs[pointerIndex]
        if (value === null || value === undefined) {
          continue
        }

        if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
          convertedArgs[pointerIndex] = ptr(value)
          continue
        }

        if (typeof value === "number" || typeof value === "bigint") {
          convertedArgs[pointerIndex] = toDenoPointer(value, deno)
        }
      }

      return nativeSymbol(...convertedArgs)
    }
  }

  return wrapped
}

function getPointerParameterIndices(symbol: CompatSymbolDefinition): number[] {
  const args = symbol.parameters ?? symbol.args ?? []
  const indices: number[] = []

  for (let i = 0; i < args.length; i++) {
    const type = args[i]
    if (type === "ptr" || type === "pointer") {
      indices.push(i)
    }
  }

  return indices
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
  let targetPointer: number | bigint | object = toDenoPointer(pointer, deno)
  if (byteOffset > 0 && deno.UnsafePointer.offset) {
    targetPointer = deno.UnsafePointer.offset(targetPointer, byteOffset)
  }

  const view = new deno.UnsafePointerView(targetPointer)
  const length = byteLength ?? 0
  return view.getArrayBuffer(length)
}

export function pointerFromAddress(address: number | bigint): Pointer {
  const runtime = detectRuntime()

  if (runtime === "bun") {
    return typeof address === "bigint" ? Number(address) : address
  }

  const deno = getDenoFFI()
  return toDenoPointer(address, deno)
}

function toPointer(value: number | bigint | object | null): Pointer {
  if (value === null) {
    throw new Error("Received null pointer")
  }

  return value
}

export function pointerToBigInt(pointer: unknown): bigint {
  if (pointer == null) {
    return 0n
  }

  if (typeof pointer === "bigint") {
    return pointer
  }

  if (typeof pointer === "number") {
    return BigInt(pointer)
  }

  const deno = getDenoGlobal() as any
  const pointerValue = deno?.UnsafePointer?.value
  if (typeof pointerValue === "function") {
    const value = pointerValue(pointer)
    if (typeof value === "bigint") {
      return value
    }
    if (typeof value === "number") {
      return BigInt(value)
    }
  }

  throw new TypeError("Unsupported pointer value")
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

function getBunFFI(): any {
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
    of: (value: ArrayBufferView) => number | bigint | object | null
    create?: (value: number | bigint) => number | bigint | object | null
    offset?: (pointer: number | bigint | object, offset: number) => number | bigint | object
    value?: (pointer: unknown) => number | bigint
  }
  UnsafePointerView: new (pointer: number | bigint | object) => { getArrayBuffer: (byteLength: number) => ArrayBuffer }
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

function toDenoPointer(
  pointer: number | bigint | object,
  deno: ReturnType<typeof getDenoFFI>,
): number | bigint | object {
  if (typeof pointer !== "number" && typeof pointer !== "bigint") {
    return pointer
  }

  const created = deno.UnsafePointer.create?.(pointer)
  if (!created) {
    throw new Error("Failed to create Deno pointer")
  }

  return created
}
