import Foundation
import Tokenizers

public struct EntityLabel: Decodable, Sendable, Equatable {
    public let type: String
    public let description: String

    public init(type: String, description: String) {
        self.type = type
        self.description = description
    }
}

public struct EntityRegion: Codable, Sendable, Equatable {
    public let startUtf16: Int
    public let endUtf16: Int

    public init(startUtf16: Int, endUtf16: Int) {
        self.startUtf16 = startUtf16
        self.endUtf16 = endUtf16
    }
}

public struct EntityMention: Encodable, Sendable, Equatable {
    public let text: String
    public let type: String
    public let score: Float
    public let startUtf16: Int
    public let endUtf16: Int
}

public struct EntityCoverage: Encodable, Sendable, Equatable {
    public let startUtf16: Int
    public let endUtf16: Int
    public let complete: Bool
}

public struct EntityChunkPlan: Encodable, Sendable, Equatable {
    public let index: Int
    public let startUtf16: Int
    public let endUtf16: Int
    public let tokenCount: Int
    public let schemaTokenCount: Int
}

public struct EntityChunkPlanResult: Encodable, Sendable, Equatable {
    public let chunks: [EntityChunkPlan]
    public let coverage: EntityCoverage
    public let schemaTokenCount: Int
}

struct PreparedEntityInput {
    let ids: [Int]
    let wordPositions: [Int]
    let markerPositions: [Int]
    let wordOffsets: [EntityRegion]
    let text: String
    let regionStartUtf16: Int
}

public enum EntityRuntimeError: LocalizedError {
    case invalidInput(String)
    case unsupportedConfiguration(String)
    case incompleteWeights([String])

    public var errorDescription: String? {
        switch self {
        case .invalidInput(let reason): return reason
        case .unsupportedConfiguration(let reason): return "Unsupported GLiNER2.5 configuration: \(reason)"
        case .incompleteWeights(let keys): return "GLiNER2.5 weights are incomplete; missing: \(keys.joined(separator: ", "))"
        }
    }
}

enum EntityText {
    static let maximumTextUTF16 = 1_000_000
    static let maximumLabels = 64
    static let addedSchemaTokenIDs = [
        "[SEP_TEXT]": 250_103,
        "[P]": 250_104,
        "[E]": 250_106,
        "[DESCRIPTION]": 250_111,
    ]

    private static func encodeSchemaToken(_ token: String, encode: (String) -> [Int]) -> [Int] {
        let markers = addedSchemaTokenIDs.keys.sorted { $0.count > $1.count }
        var remaining = token[...]
        var result: [Int] = []
        while !remaining.isEmpty {
            let next = markers.compactMap { marker -> (Range<String.Index>, String)? in
                guard let range = remaining.range(of: marker) else { return nil }
                return (range, marker)
            }.min { $0.0.lowerBound < $1.0.lowerBound }
            guard let (range, marker) = next else {
                result.append(contentsOf: encode(String(remaining)))
                break
            }
            if range.lowerBound > remaining.startIndex {
                result.append(contentsOf: encode(String(remaining[..<range.lowerBound])))
            }
            result.append(addedSchemaTokenIDs[marker]!)
            remaining = remaining[range.upperBound...]
        }
        return result
    }

    // This expression is the word boundary pattern used by the pinned mlx-vlm
    // reference. Python's Unicode `\w` excludes combining marks, unlike ICU's;
    // spell out Python's letters/numbers/underscore class to retain token parity.
    private static let wordPattern = try! NSRegularExpression(
        pattern: #"(?:https?://[^\s]+|www\.[^\s]+)|[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}|@[a-z0-9_]+|[\p{L}\p{N}_]+(?:[-_][\p{L}\p{N}_]+)*|\S"#,
        options: [.caseInsensitive]
    )

    private static func isScalarBoundary(_ offset: Int, in source: NSString) -> Bool {
        guard offset > 0, offset < source.length else { return offset >= 0 && offset <= source.length }
        let previous = source.character(at: offset - 1)
        let next = source.character(at: offset)
        return !(0xD800...0xDBFF).contains(previous) || !(0xDC00...0xDFFF).contains(next)
    }

    static func prepare(
        fullText: String,
        region: EntityRegion,
        labels: [EntityLabel],
        encode: (String) -> [Int],
        unknownTokenID: Int?,
        maxTokens: Int
    ) throws -> PreparedEntityInput {
        let source = fullText as NSString
        guard source.length <= maximumTextUTF16 else {
            throw EntityRuntimeError.invalidInput("text exceeds the 1,000,000 UTF-16 unit safety limit")
        }
        guard region.startUtf16 >= 0, region.endUtf16 >= region.startUtf16,
              region.endUtf16 <= source.length,
              isScalarBoundary(region.startUtf16, in: source), isScalarBoundary(region.endUtf16, in: source) else {
            throw EntityRuntimeError.invalidInput("region must use valid UTF-16 boundaries inside text")
        }
        guard labels.count <= maximumLabels else {
            throw EntityRuntimeError.invalidInput("schema has more than \(maximumLabels) entity labels")
        }
        guard Set(labels.map(\.type)).count == labels.count else {
            throw EntityRuntimeError.invalidInput("entity label types must be unique")
        }
        guard maxTokens > 0, maxTokens <= 512 else {
            throw EntityRuntimeError.invalidInput("maxTokens must be between 1 and 512 for the pinned encoder")
        }
        guard labels.allSatisfy({ !$0.type.isEmpty && !$0.description.isEmpty }) else {
            throw EntityRuntimeError.invalidInput("every entity label needs a non-empty type and description")
        }

        let regionText = source.substring(with: NSRange(location: region.startUtf16, length: region.endUtf16 - region.startUtf16))
        let schema = schemaTokens(labels)
        var ids: [Int] = []
        var markers: [Int] = []
        let markerSlots = Set([1] + stride(from: 4, to: max(4, schema.count - 2), by: 2))
        for (index, token) in schema.enumerated() {
            if markerSlots.contains(index) { markers.append(ids.count) }
            ids.append(contentsOf: encodeSchemaToken(token, encode: encode))
        }
        ids.append(contentsOf: encodeSchemaToken("[SEP_TEXT]", encode: encode))
        guard ids.count < maxTokens else {
            throw EntityRuntimeError.invalidInput("schema alone exceeds the request token budget")
        }

        let sourceRegion = regionText as NSString
        let search = NSRange(location: 0, length: sourceRegion.length)
        let matches = wordPattern.matches(in: regionText, range: search)
        var words: [String] = []
        var offsets: [EntityRegion] = []
        var positions: [Int] = []
        for match in matches {
            let word = sourceRegion.substring(with: match.range).lowercased()
            var pieces = encode(word)
            if pieces.isEmpty {
                guard let unknownID = unknownTokenID else {
                    throw EntityRuntimeError.invalidInput("the pinned tokenizer does not define an unknown-token id")
                }
                pieces = [unknownID]
            }
            guard ids.count + pieces.count <= maxTokens else {
                throw EntityRuntimeError.invalidInput("region exceeds maxTokens; use plan_entity_chunks and retry bounded regions")
            }
            positions.append(ids.count)
            words.append(word)
            offsets.append(EntityRegion(
                startUtf16: region.startUtf16 + match.range.location,
                endUtf16: region.startUtf16 + NSMaxRange(match.range)
            ))
            ids.append(contentsOf: pieces)
        }
        return PreparedEntityInput(
            ids: ids,
            wordPositions: positions,
            markerPositions: markers,
            wordOffsets: offsets,
            text: fullText,
            regionStartUtf16: region.startUtf16
        )
    }

    static func plan(fullText: String, labels: [EntityLabel], encode: (String) -> [Int], unknownTokenID: Int?,
                     maxTokens: Int, overlapTokens: Int) throws -> EntityChunkPlanResult {
        let source = fullText as NSString
        guard source.length <= maximumTextUTF16 else {
            throw EntityRuntimeError.invalidInput("text exceeds the 1,000,000 UTF-16 unit safety limit")
        }
        guard labels.count <= maximumLabels, Set(labels.map(\.type)).count == labels.count else {
            throw EntityRuntimeError.invalidInput("schema must contain at most 64 unique entity label types")
        }
        guard labels.allSatisfy({ !$0.type.isEmpty && !$0.description.isEmpty }) else {
            throw EntityRuntimeError.invalidInput("every entity label needs a non-empty type and description")
        }
        guard maxTokens > 0, maxTokens <= 512 else {
            throw EntityRuntimeError.invalidInput("maxTokens must be between 1 and 512 for the pinned encoder")
        }
        let schema = schemaTokens(labels)
        let schemaCount = schema.reduce(0) { $0 + encodeSchemaToken($1, encode: encode).count } +
            encodeSchemaToken("[SEP_TEXT]", encode: encode).count
        let textBudget = maxTokens - schemaCount
        guard textBudget > 0 else { throw EntityRuntimeError.invalidInput("schema alone exceeds maxTokens") }
        guard overlapTokens >= 0, overlapTokens < textBudget else {
            throw EntityRuntimeError.invalidInput("overlapTokens must be non-negative and smaller than the text token budget")
        }
        let matches = wordPattern.matches(in: fullText, range: NSRange(location: 0, length: source.length))
        let words: [(range: NSRange, tokenCount: Int)] = try matches.map { match in
            let text = source.substring(with: match.range).lowercased()
            var count = encode(text).count
            if count == 0 {
                guard unknownTokenID != nil else {
                    throw EntityRuntimeError.invalidInput("the pinned tokenizer does not define an unknown-token id")
                }
                count = 1
            }
            guard count <= textBudget else {
                throw EntityRuntimeError.invalidInput("one word exceeds the token budget and cannot be split without changing reference boundaries")
            }
            return (match.range, count)
        }
        guard !words.isEmpty else {
            return EntityChunkPlanResult(chunks: [EntityChunkPlan(index: 0, startUtf16: 0, endUtf16: source.length,
                                                                    tokenCount: 0, schemaTokenCount: schemaCount)],
                                         coverage: EntityCoverage(startUtf16: 0, endUtf16: source.length, complete: true),
                                         schemaTokenCount: schemaCount)
        }

        var chunks: [EntityChunkPlan] = []
        var cursor = 0
        var chunkIndex = 0
        while cursor < words.count {
            var end = cursor
            var used = 0
            while end < words.count, used + words[end].tokenCount <= textBudget {
                used += words[end].tokenCount
                end += 1
            }
            guard end > cursor else { throw EntityRuntimeError.invalidInput("no text token fits after the schema overhead") }
            let chunkStart = cursor == 0 ? 0 : words[cursor].range.location
            let chunkEnd = end == words.count ? source.length : words[end].range.location
            chunks.append(EntityChunkPlan(index: chunkIndex, startUtf16: chunkStart, endUtf16: chunkEnd,
                                          tokenCount: used,
                                          schemaTokenCount: schemaCount))
            chunkIndex += 1
            if end == words.count { break }
            var overlapCount = 0
            var nextStart = end
            while nextStart > cursor, overlapCount < overlapTokens {
                nextStart -= 1
                overlapCount += words[nextStart].tokenCount
            }
            cursor = min(max(nextStart, cursor + 1), end)
        }
        return EntityChunkPlanResult(chunks: chunks,
                                     coverage: EntityCoverage(startUtf16: 0, endUtf16: source.length, complete: true),
                                     schemaTokenCount: schemaCount)
    }

    static func schemaTokens(_ labels: [EntityLabel]) -> [String] {
        var prompt = "entities"
        for label in labels { prompt += " [DESCRIPTION] \(label.type): \(label.description)" }
        var result = ["(", "[P]", prompt, "("]
        for label in labels { result.append(contentsOf: ["[E]", label.type]) }
        result.append(contentsOf: [")", ")"])
        return result
    }

    static func exactSlice(_ text: String, startUtf16: Int, endUtf16: Int) throws -> String {
        let nsText = text as NSString
        guard startUtf16 >= 0, endUtf16 >= startUtf16, endUtf16 <= nsText.length else {
            throw EntityRuntimeError.invalidInput("mention offsets fall outside the original text")
        }
        let range = NSRange(location: startUtf16, length: endUtf16 - startUtf16)
        guard isScalarBoundary(startUtf16, in: nsText), isScalarBoundary(endUtf16, in: nsText) else {
            throw EntityRuntimeError.invalidInput("mention offsets split a UTF-16 surrogate pair")
        }
        return nsText.substring(with: range)
    }
}
