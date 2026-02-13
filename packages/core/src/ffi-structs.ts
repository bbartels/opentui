import { pointerToBigInt, ptr, toArrayBuffer, type Pointer } from "./ffi"

type PrimitiveType = "u8" | "bool_u8" | "bool_u32" | "u16" | "i16" | "u32" | "i32" | "u64" | "f32" | "f64" | "pointer"
type StructType = PrimitiveType | "char*"
type FieldType = StructType | EnumDef<any> | [PrimitiveType]

type FieldOptions = {
  optional?: boolean
  default?: unknown
  lengthOf?: string
  packTransform?: (value: unknown) => unknown
  unpackTransform?: (value: unknown) => unknown
}

type FieldDef = [name: string, type: FieldType, options?: FieldOptions]

type StructDefOptions<T> = {
  reduceValue?: (value: T) => Record<string, unknown>
}

type EnumDef<T extends Record<string, number>> = {
  __type: "enum"
  type: PrimitiveType
  enum: T
  to: (value: keyof T | number) => number
  from: (value: number) => keyof T
}

type BuiltStruct<T> = {
  __type: "struct"
  size: number
  pack: (value: T | Record<string, unknown>) => ArrayBuffer
  unpack: (buffer: ArrayBuffer) => T
  packList: (values: Array<T | Record<string, unknown>>) => ArrayBuffer
  unpackList: (buffer: ArrayBuffer, count: number) => T[]
}

const pointerSize = getPointerSize()
const encoder = new TextEncoder()
const decoder = new TextDecoder()

const primitiveSizes: Record<PrimitiveType, number> = {
  u8: 1,
  bool_u8: 1,
  bool_u32: 4,
  u16: 2,
  i16: 2,
  u32: 4,
  i32: 4,
  u64: 8,
  f32: 4,
  f64: 8,
  pointer: pointerSize,
}

type LayoutEntry = {
  name: string
  kind: "primitive" | "char_ptr" | "enum" | "array"
  type: PrimitiveType
  offset: number
  size: number
  optional: boolean
  defaultValue: unknown
  lengthOf?: string
  packTransform?: (value: unknown) => unknown
  unpackTransform?: (value: unknown) => unknown
  enumDef?: EnumDef<any>
}

export function defineEnum<T extends Record<string, number>>(mapping: T, base: PrimitiveType = "u32"): EnumDef<T> {
  const reverse = new Map<number, keyof T>()
  for (const [name, value] of Object.entries(mapping)) {
    reverse.set(value, name as keyof T)
  }

  return {
    __type: "enum",
    type: base,
    enum: mapping,
    to(value: keyof T | number): number {
      if (typeof value === "number") {
        return value
      }
      const mapped = mapping[value]
      if (mapped === undefined) {
        throw new TypeError(`Invalid enum value: ${String(value)}`)
      }
      return mapped
    },
    from(value: number): keyof T {
      const mapped = reverse.get(value)
      if (mapped === undefined) {
        throw new TypeError(`Invalid enum numeric value: ${value}`)
      }
      return mapped
    },
  }
}

export function defineStruct<T = any>(fields: FieldDef[], options: StructDefOptions<T> = {}): BuiltStruct<T> {
  let offset = 0
  const layout: LayoutEntry[] = []

  for (const [name, rawType, rawOptions] of fields) {
    const fieldOptions: FieldOptions = rawOptions ?? {}

    let kind: LayoutEntry["kind"]
    let type: PrimitiveType
    let size: number
    let enumDef: EnumDef<any> | undefined

    if (Array.isArray(rawType)) {
      kind = "array"
      type = rawType[0]
      size = pointerSize
    } else if (typeof rawType === "string") {
      if (rawType === "char*") {
        kind = "char_ptr"
        type = "pointer"
        size = pointerSize
      } else {
        kind = "primitive"
        type = rawType
        size = primitiveSizes[type]
      }
    } else {
      kind = "enum"
      type = rawType.type
      size = primitiveSizes[type]
      enumDef = rawType
    }

    const align = Math.max(1, Math.min(size, pointerSize))
    offset = alignOffset(offset, align)

    layout.push({
      name,
      kind,
      type,
      offset,
      size,
      optional: fieldOptions.optional ?? false,
      defaultValue: fieldOptions.default,
      lengthOf: fieldOptions.lengthOf,
      packTransform: fieldOptions.packTransform,
      unpackTransform: fieldOptions.unpackTransform,
      enumDef,
    })

    offset += size
  }

  const size = alignOffset(offset, pointerSize)
  const byName = new Map(layout.map((entry) => [entry.name, entry]))
  const inferredLengthFieldFor = new Map<string, string>()

  for (const entry of layout) {
    if (!entry.lengthOf) {
      continue
    }

    if (entry.kind === "primitive" || entry.kind === "enum") {
      inferredLengthFieldFor.set(entry.lengthOf, entry.name)
    }
  }

  function pack(value: T | Record<string, unknown>): ArrayBuffer {
    const input = options.reduceValue ? options.reduceValue(value as T) : (value as Record<string, unknown>)
    const buffer = new ArrayBuffer(size)
    const view = new DataView(buffer)

    const allocated: ArrayBuffer[] = []

    for (const entry of layout) {
      let fieldValue = input[entry.name]

      if (fieldValue === undefined && entry.defaultValue !== undefined) {
        fieldValue = entry.defaultValue
      }
      if (entry.packTransform) {
        fieldValue = entry.packTransform(fieldValue)
      }

      if ((entry.kind === "primitive" || entry.kind === "enum") && entry.lengthOf) {
        const sourceValue = input[entry.lengthOf]

        if (typeof sourceValue === "string") {
          fieldValue = encoder.encode(sourceValue).length
        } else if (Array.isArray(sourceValue)) {
          fieldValue = sourceValue.length
        } else if (sourceValue instanceof ArrayBuffer) {
          fieldValue = sourceValue.byteLength
        } else if (ArrayBuffer.isView(sourceValue)) {
          fieldValue = sourceValue.byteLength
        }
      }

      if (fieldValue === undefined && entry.optional) {
        fieldValue = null
      }

      switch (entry.kind) {
        case "primitive":
          writePrimitive(view, entry.type, entry.offset, fieldValue)
          break
        case "enum":
          writePrimitive(view, entry.type, entry.offset, entry.enumDef!.to(fieldValue as number))
          break
        case "char_ptr": {
          const text = fieldValue == null ? "" : String(fieldValue)
          const encoded = encoder.encode(text)
          if (encoded.length === 0) {
            writePrimitive(view, "pointer", entry.offset, 0)
          } else {
            allocated.push(encoded.buffer)
            writePrimitive(view, "pointer", entry.offset, ptr(encoded))
          }
          if (entry.lengthOf) {
            const lenField = byName.get(entry.lengthOf)
            if (lenField) {
              writePrimitive(view, lenField.type, lenField.offset, encoded.length)
            }
          }
          break
        }
        case "array": {
          const values = Array.isArray(fieldValue) ? fieldValue : []
          const elementSize = primitiveSizes[entry.type]
          const arrBuf = new ArrayBuffer(values.length * elementSize)
          const arrView = new DataView(arrBuf)

          for (let i = 0; i < values.length; i++) {
            writePrimitive(arrView, entry.type, i * elementSize, values[i])
          }

          if (values.length === 0) {
            writePrimitive(view, "pointer", entry.offset, 0)
          } else {
            allocated.push(arrBuf)
            writePrimitive(view, "pointer", entry.offset, ptr(arrBuf))
          }

          if (entry.lengthOf) {
            const lenField = byName.get(entry.lengthOf)
            if (lenField) {
              writePrimitive(view, lenField.type, lenField.offset, values.length)
            }
          }
          break
        }
      }
    }

    ;(buffer as ArrayBuffer & { _refs?: ArrayBuffer[] })._refs = allocated
    return buffer
  }

  function unpack(buffer: ArrayBuffer): T {
    const view = new DataView(buffer)
    const out: Record<string, unknown> = {}

    const getLengthFieldValue = (fieldName: string | undefined): number => {
      if (!fieldName) {
        return 0
      }

      const existing = out[fieldName]
      if (existing !== undefined) {
        return Number(existing)
      }

      const field = byName.get(fieldName)
      if (!field) {
        return 0
      }

      return Number(readPrimitive(view, field.type, field.offset))
    }

    for (const entry of layout) {
      let value: unknown

      switch (entry.kind) {
        case "primitive":
          value = readPrimitive(view, entry.type, entry.offset)
          break
        case "enum": {
          const raw = Number(readPrimitive(view, entry.type, entry.offset))
          value = entry.enumDef!.from(raw)
          break
        }
        case "char_ptr": {
          const pointer = readPrimitive(view, "pointer", entry.offset) as number | bigint
          const lenField = entry.lengthOf ?? inferredLengthFieldFor.get(entry.name)
          const len = getLengthFieldValue(lenField)
          if (!pointer || len <= 0) {
            value = ""
          } else {
            const bytes = new Uint8Array(toArrayBuffer(pointer as Pointer, 0, len))
            value = decoder.decode(bytes)
          }
          break
        }
        case "array": {
          const pointer = readPrimitive(view, "pointer", entry.offset) as number | bigint
          const lenField = entry.lengthOf ?? inferredLengthFieldFor.get(entry.name)
          const len = getLengthFieldValue(lenField)
          if (!pointer || len <= 0) {
            value = []
          } else {
            const elementSize = primitiveSizes[entry.type]
            const arrView = new DataView(toArrayBuffer(pointer as Pointer, 0, len * elementSize))
            const items: unknown[] = []
            for (let i = 0; i < len; i++) {
              items.push(readPrimitive(arrView, entry.type, i * elementSize))
            }
            value = items
          }
          break
        }
      }

      if (entry.unpackTransform) {
        value = entry.unpackTransform(value)
      }

      out[entry.name] = value
    }

    return out as T
  }

  function packList(values: Array<T | Record<string, unknown>>): ArrayBuffer {
    const listBuffer = new ArrayBuffer(size * values.length)
    const outView = new Uint8Array(listBuffer)
    const refs: ArrayBuffer[] = []

    for (let i = 0; i < values.length; i++) {
      const packed = pack(values[i])
      outView.set(new Uint8Array(packed), i * size)

      refs.push(packed)
      const packedRefs = (packed as ArrayBuffer & { _refs?: ArrayBuffer[] })._refs
      if (packedRefs) {
        refs.push(...packedRefs)
      }
    }

    ;(listBuffer as ArrayBuffer & { _refs?: ArrayBuffer[] })._refs = refs

    return listBuffer
  }

  function unpackList(buffer: ArrayBuffer, count: number): T[] {
    const out: T[] = []
    const bytes = new Uint8Array(buffer)

    for (let i = 0; i < count; i++) {
      const start = i * size
      out.push(unpack(bytes.slice(start, start + size).buffer))
    }

    return out
  }

  return {
    __type: "struct",
    size,
    pack,
    unpack,
    packList,
    unpackList,
  }
}

function writePrimitive(view: DataView, type: PrimitiveType, offset: number, value: unknown): void {
  switch (type) {
    case "u8":
      view.setUint8(offset, Number(value ?? 0))
      return
    case "bool_u8":
      view.setUint8(offset, value ? 1 : 0)
      return
    case "bool_u32":
      view.setUint32(offset, value ? 1 : 0, true)
      return
    case "u16":
      view.setUint16(offset, Number(value ?? 0), true)
      return
    case "i16":
      view.setInt16(offset, Number(value ?? 0), true)
      return
    case "u32":
      view.setUint32(offset, Number(value ?? 0), true)
      return
    case "i32":
      view.setInt32(offset, Number(value ?? 0), true)
      return
    case "u64":
      view.setBigUint64(offset, BigInt((value ?? 0) as number | bigint), true)
      return
    case "f32":
      view.setFloat32(offset, Number(value ?? 0), true)
      return
    case "f64":
      view.setFloat64(offset, Number(value ?? 0), true)
      return
    case "pointer": {
      const pointer = pointerToBigInt(value)
      if (pointerSize === 8) {
        view.setBigUint64(offset, pointer, true)
      } else {
        view.setUint32(offset, Number(pointer), true)
      }
      return
    }
  }
}

function readPrimitive(view: DataView, type: PrimitiveType, offset: number): number | bigint | boolean {
  switch (type) {
    case "u8":
      return view.getUint8(offset)
    case "bool_u8":
      return Boolean(view.getUint8(offset))
    case "bool_u32":
      return Boolean(view.getUint32(offset, true))
    case "u16":
      return view.getUint16(offset, true)
    case "i16":
      return view.getInt16(offset, true)
    case "u32":
      return view.getUint32(offset, true)
    case "i32":
      return view.getInt32(offset, true)
    case "u64":
      return view.getBigUint64(offset, true)
    case "f32":
      return view.getFloat32(offset, true)
    case "f64":
      return view.getFloat64(offset, true)
    case "pointer":
      return pointerSize === 8 ? view.getBigUint64(offset, true) : BigInt(view.getUint32(offset, true))
  }
}

function alignOffset(offset: number, align: number): number {
  return (offset + align - 1) & ~(align - 1)
}

function getPointerSize(): number {
  const procArch = (globalThis as { process?: { arch?: string } }).process?.arch
  if (procArch === "x64" || procArch === "arm64") {
    return 8
  }

  const denoArch = (globalThis as { Deno?: { build?: { arch?: string } } }).Deno?.build?.arch
  if (denoArch === "x86_64" || denoArch === "aarch64") {
    return 8
  }

  return 4
}
