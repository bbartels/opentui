let segmenter: Intl.Segmenter | null = null

export function getGraphemeSegmenter(): Intl.Segmenter {
  if (segmenter) return segmenter
  segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" })
  return segmenter
}

function isHighSurrogate(code: number): boolean {
  return code >= 0xd800 && code <= 0xdbff
}

function isLowSurrogate(code: number): boolean {
  return code >= 0xdc00 && code <= 0xdfff
}

export function isSingleGrapheme(s: string): boolean {
  if (s.length === 0) return false
  if (s.length === 1) return true

  const first = s.charCodeAt(0)
  if (first < 128) {
    const second = s.charCodeAt(1)
    if (second < 128) return false
  }

  const iter = getGraphemeSegmenter().segment(s)[Symbol.iterator]()
  iter.next()
  return iter.next().done === true
}

export function firstGrapheme(str: string): string {
  if (str.length === 0) return ""

  const firstCode = str.charCodeAt(0)
  if (firstCode < 128) {
    if (str.length === 1) return str[0]!
    const secondCode = str.charCodeAt(1)
    if (secondCode < 128) return str[0]!
  } else if (str.length === 1 && (firstCode < 0xd800 || firstCode > 0xdfff)) {
    // Single non-surrogate codepoint
    return str[0]!
  } else if (isHighSurrogate(firstCode)) {
    const secondCode = str.charCodeAt(1)
    if (isLowSurrogate(secondCode) && str.length === 2) {
      return str.substring(0, 2)
    }
  }

  const segments = getGraphemeSegmenter().segment(str)
  const first = segments[Symbol.iterator]().next()
  return first.done ? "" : first.value.segment
}
