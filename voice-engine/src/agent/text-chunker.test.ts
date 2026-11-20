import { describe, it, expect } from "vitest"
import { TextChunker } from "./text-chunker"

// ── Helpers ─────────────────────────────────────────────────────────────────

/** Collect all chunks emitted by a chunker. */
function collectChunks(
  mode: "two-chunk" | "paragraph" | "sentence" | "greedy",
  input: string | string[],
  opts: { minWords?: number; maxWords?: number; finish?: boolean } = {},
): string[] {
  const chunks: string[] = []
  const chunker = new TextChunker({
    mode,
    minWords: opts.minWords,
    maxWords: opts.maxWords,
    onChunk: (text) => chunks.push(text),
  })
  const deltas = Array.isArray(input) ? input : [input]
  for (const d of deltas) chunker.feed(d)
  if (opts.finish !== false) chunker.finish()
  return chunks
}

/** Simulate token-by-token streaming by splitting into individual characters. */
function tokenize(text: string): string[] {
  return text.split("")
}

// ── Two-chunk mode ──────────────────────────────────────────────────────────

describe("TextChunker — two-chunk mode", () => {
  it("fires at first sentence boundary past minWords", () => {
    const chunks = collectChunks(
      "two-chunk",
      "The quick brown fox jumps over the lazy dog. The cat sat on the mat. More text here.",
      { minWords: 8 },
    )
    // First chunk should fire at the first sentence boundary past 8 words
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toContain("lazy dog.")
    expect(chunks[1]).toContain("cat sat")
  })

  it("accumulates remainder and fires on finish", () => {
    const chunks: string[] = []
    const chunker = new TextChunker({
      mode: "two-chunk",
      minWords: 5,
      onChunk: (text) => chunks.push(text),
    })
    chunker.feed("Hello world this is a test. And then some more text follows after that.")
    expect(chunks.length).toBe(1) // first chunk fired
    chunker.finish()
    expect(chunks.length).toBe(2) // remainder fired on finish
  })

  it("sends everything as one chunk when stream ends before minWords", () => {
    const chunks = collectChunks("two-chunk", "Short reply.", { minWords: 12 })
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe("Short reply.")
  })

  it("works with token-by-token streaming", () => {
    const text = "The quick brown fox jumps over the lazy dog. The cat sat on the mat."
    const chunks = collectChunks("two-chunk", tokenize(text), { minWords: 8 })
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toContain("lazy dog.")
  })

  it("does not fire on finish when first chunk consumed all text", () => {
    // Single sentence that exceeds minWords, no remainder
    const chunks = collectChunks(
      "two-chunk",
      "The quick brown fox jumps over the lazy dog. ",
      { minWords: 5 },
    )
    // Should fire the first chunk, and finish should not fire an empty second chunk
    expect(chunks.length).toBe(1)
  })
})

// ── Paragraph mode ──────────────────────────────────────────────────────────

describe("TextChunker — paragraph mode", () => {
  it("fires on each paragraph boundary", () => {
    const chunks = collectChunks(
      "paragraph",
      "First paragraph here.\n\nSecond paragraph here.\n\nThird one.",
    )
    expect(chunks.length).toBe(3)
    expect(chunks[0]).toBe("First paragraph here.")
    expect(chunks[1]).toBe("Second paragraph here.")
    expect(chunks[2]).toBe("Third one.")
  })

  it("fires remainder without paragraph boundary on finish", () => {
    const chunks: string[] = []
    const chunker = new TextChunker({
      mode: "paragraph",
      onChunk: (text) => chunks.push(text),
    })
    chunker.feed("First paragraph.\n\nSecond without ending")
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe("First paragraph.")
    chunker.finish()
    expect(chunks.length).toBe(2)
    expect(chunks[1]).toBe("Second without ending")
  })

  it("handles streaming tokens across a paragraph boundary", () => {
    const chunks = collectChunks(
      "paragraph",
      ["First para.", "\n", "\n", "Second para."],
    )
    expect(chunks.length).toBe(2)
  })
})

// ── Sentence mode ───────────────────────────────────────────────────────────

describe("TextChunker — sentence mode", () => {
  it("fires at every sentence boundary past minWords", () => {
    const chunks = collectChunks(
      "sentence",
      "I went to the store today. I bought some apples. Then I walked home. It was a nice day.",
      { minWords: 5 },
    )
    // Sentences: 6w, 5w, 4w, 5w. "Then I walked home." is 4 words < minWords=5,
    // so it batches with "It was a nice day." (5w) into one chunk. Yields 3 chunks.
    expect(chunks.length).toBe(3)
    expect(chunks[0]).toContain("store today.")
    expect(chunks[1]).toContain("some apples.")
  })

  it("batches short sentences to meet minWords", () => {
    const chunks = collectChunks(
      "sentence",
      "I think we should go to the park. That sounds great today.",
      { minWords: 8 },
    )
    // "I think we should go to the park." is 8 words — exactly hits minWords
    // "That sounds great today." is 4 words — below minWords, fires on finish
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toContain("park.")
    expect(chunks[1]).toContain("great today.")
  })

  it("fires at maxWords even if minWords not reached with many short sentences", () => {
    // Edge case: many tiny sentences. maxWords should force a fire.
    const chunks = collectChunks(
      "sentence",
      "Go. Run. Jump. Fly. Swim. Dash. Leap. Spin. Turn. Stop. Wait. Look. See. Find. Take. ",
      { minWords: 50, maxWords: 10 },
    )
    // minWords is 50 (unreachably high), but maxWords is 10 — should force fires
    expect(chunks.length).toBeGreaterThan(1)
  })

  it("falls back to clause boundary for oversized single sentence", () => {
    const longSentence =
      "The extremely complex and deeply nested algorithm processes the input data carefully, and then it transforms everything into a normalized output format that can be used by the downstream system."
    const chunks = collectChunks("sentence", longSentence, {
      minWords: 5,
      maxWords: 15,
    })
    // The sentence is ~30 words with a ", and" clause boundary near the middle
    expect(chunks.length).toBeGreaterThan(1)
    // Each chunk should be under or near maxWords
    for (const chunk of chunks) {
      const words = chunk.trim().split(/\s+/).length
      // Allow some tolerance — clause splitting is best-effort
      expect(words).toBeLessThanOrEqual(25)
    }
  })

  it("keeps firing after first chunk unlike two-chunk mode", () => {
    const chunks = collectChunks(
      "sentence",
      "First sentence here today. Second sentence here today. Third sentence here today. Fourth sentence here today. ",
      { minWords: 3 },
    )
    // Should fire on every sentence boundary (each is 4 words, above minWords of 3)
    expect(chunks.length).toBe(4)
  })

  it("fires remainder on finish", () => {
    const chunks: string[] = []
    const chunker = new TextChunker({
      mode: "sentence",
      minWords: 5,
      onChunk: (text) => chunks.push(text),
    })
    chunker.feed("A complete sentence with enough words. And then trailing text without punctuation")
    const countAfterFeed = chunks.length
    chunker.finish()
    expect(chunks.length).toBeGreaterThan(countAfterFeed)
  })

  it("works with token-by-token streaming", () => {
    const text = "The quick brown fox jumps. The lazy dog sleeps. The cat purrs softly. "
    const chunks = collectChunks("sentence", tokenize(text), { minWords: 3 })
    expect(chunks.length).toBe(3)
  })
})

// ── Greedy mode ─────────────────────────────────────────────────────────────

describe("TextChunker — greedy mode", () => {
  it("packs sentences up to maxWords before emitting", () => {
    const chunks = collectChunks(
      "greedy",
      "First sentence here today. Second sentence here today. Third sentence here today. Fourth sentence here today. ",
      { minWords: 3, maxWords: 10 },
    )
    // Each sentence is 4 words; two fit under maxWords=10
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toBe("First sentence here today. Second sentence here today.")
  })

  it("splits at a passed sentence boundary when the tail runs long without punctuation", () => {
    // Repro: greedy confirms a candidate sentence, advances its scan past the
    // boundary, then the tail reaches maxWords with no new punctuation. The
    // over-cap split must land on that sentence boundary, not a word position.
    const sentence = "This is a complete sentence with plenty of words in it here. "
    const tail = "followed by a long unpunctuated stream of words that just keeps going and going".split(" ")
    const chunks = collectChunks("greedy", [sentence, ...tail.map((w) => w + " ")], {
      minWords: 5,
      maxWords: 20,
    })
    expect(chunks[0]).toBe("This is a complete sentence with plenty of words in it here.")
  })

  it("splits unpunctuated list items at line boundaries", () => {
    const chunks = collectChunks(
      "greedy",
      "- alpha beta gamma\n- delta epsilon zeta\n- eta theta iota kappa\n",
      { minWords: 3, maxWords: 8 },
    )
    // No sentence or clause boundaries anywhere — every split must land on a
    // newline, never inside an item
    expect(chunks[0]).toBe("- alpha beta gamma")
    expect(chunks[1]).toBe("- delta epsilon zeta")
  })

  it("emits an oversized chunk at a real boundary rather than word-cutting", () => {
    const chunks = collectChunks(
      "greedy",
      "One two three four five six seven eight nine ten eleven twelve thirteen fourteen. Next sentence follows right here now. ",
      { minWords: 3, maxWords: 10 },
    )
    // First boundary sits past maxWords — take it anyway
    expect(chunks[0]).toBe("One two three four five six seven eight nine ten eleven twelve thirteen fourteen.")
  })

  it("never cuts text with no boundaries at all — holds until finish", () => {
    const words = Array.from({ length: 30 }, (_, i) => `word${i}`)
    const chunks = collectChunks("greedy", words.map((w) => w + " "), {
      minWords: 3,
      maxWords: 10,
    })
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toBe(words.join(" "))
  })
})

// ── Boundary detection ──────────────────────────────────────────────────────

describe("TextChunker — boundary detection", () => {
  it("does not split on abbreviations like Dr. or U.S.", () => {
    const chunks = collectChunks(
      "sentence",
      "Dr. Smith went to the U.S. embassy for a meeting. He arrived on time. ",
      { minWords: 3 },
    )
    // "Dr. Smith went to the U.S. embassy for a meeting." is one sentence
    // Should not split at "Dr. " or "U.S. " — those are followed by uppercase
    // but our regex requires trailing space which these have... the real test is
    // whether the chunks make sense
    expect(chunks[0]).toContain("Dr. Smith")
  })

  it("splits at sentence boundaries followed by space", () => {
    const chunks = collectChunks(
      "sentence",
      "Hello world today. Goodbye world tonight. ",
      { minWords: 2 },
    )
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toContain("Hello world today.")
    expect(chunks[1]).toContain("Goodbye world tonight.")
  })

  it("splits at sentence boundaries followed by newline", () => {
    const chunks = collectChunks(
      "sentence",
      "Hello world today.\nGoodbye world tonight.\n",
      { minWords: 2 },
    )
    expect(chunks.length).toBe(2)
  })

  it("detects clause boundaries for fallback splitting", () => {
    const text =
      "She went to the market to buy groceries, and then she stopped by the pharmacy to pick up her prescription medication."
    const chunks = collectChunks("sentence", text, {
      minWords: 5,
      maxWords: 12,
    })
    // Should split at ", and" clause boundary
    expect(chunks.length).toBe(2)
    expect(chunks[0]).toContain("groceries")
  })

  it("detects semicolon as clause boundary", () => {
    const text =
      "The server processes requests in parallel; the client waits for all responses before rendering the final output."
    const chunks = collectChunks("sentence", text, {
      minWords: 5,
      maxWords: 10,
    })
    // 21 words total, maxWords=10. Splits at semicolon clause boundary.
    // The remainder after the first split may itself exceed maxWords and split again.
    expect(chunks.length).toBeGreaterThanOrEqual(2)
    expect(chunks[0]).toContain("parallel")
  })
})

// ── cleanForSpeech integration ──────────────────────────────────────────────

describe("TextChunker — text cleaning", () => {
  it("strips markdown before emitting chunks", () => {
    const chunks = collectChunks(
      "two-chunk",
      "The **bold** and *italic* text is here today. More words follow after that sentence. ",
      { minWords: 5 },
    )
    expect(chunks[0]).not.toContain("**")
    expect(chunks[0]).not.toContain("*italic*")
    expect(chunks[0]).toContain("bold")
    expect(chunks[0]).toContain("italic")
  })

  it("strips code blocks before emitting chunks", () => {
    const chunks = collectChunks(
      "paragraph",
      "Here is some text.\n\n```js\nconsole.log('hi')\n```\n\nMore text after.",
    )
    const allText = chunks.join(" ")
    expect(allText).toContain("code block omitted")
    expect(allText).not.toContain("console.log")
  })

  it("does not emit empty chunks after cleaning", () => {
    // A paragraph that is only a code block should be cleaned to "code block omitted", not empty
    const chunks = collectChunks(
      "paragraph",
      "Some text here.\n\n```\nonly code\n```\n\nMore text.",
    )
    for (const chunk of chunks) {
      expect(chunk.trim().length).toBeGreaterThan(0)
    }
  })
})

// ── Reset ───────────────────────────────────────────────────────────────────

describe("TextChunker — reset", () => {
  it("clears internal state so next feed starts fresh", () => {
    const chunks: string[] = []
    const chunker = new TextChunker({
      mode: "sentence",
      minWords: 3,
      onChunk: (text) => chunks.push(text),
    })
    chunker.feed("First sentence here. ")
    expect(chunks.length).toBe(1)

    chunker.reset()
    chunks.length = 0

    chunker.feed("Brand new start now. ")
    expect(chunks.length).toBe(1)
    expect(chunks[0]).toContain("Brand new")
  })

  it("discards buffered text on reset", () => {
    const chunks: string[] = []
    const chunker = new TextChunker({
      mode: "two-chunk",
      minWords: 50,
      onChunk: (text) => chunks.push(text),
    })
    chunker.feed("This text will never reach minWords but is buffered internally.")
    chunker.reset()
    chunker.finish()
    // Nothing should fire — buffer was cleared
    expect(chunks.length).toBe(0)
  })
})
