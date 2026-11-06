import Foundation
import Testing
@testable import FolioMLXEntities

@Suite struct EntityTextTests {
    private let labels = [EntityLabel(type: "person", description: "person")]
    private let markerIds = ["[SEP_TEXT]": 250_103, "[P]": 250_104, "[E]": 250_106, "[DESCRIPTION]": 250_111]

    private func encode(_ text: String) -> [Int] {
        if let id = markerIds[text] { return [id] }
        let regex = try! NSRegularExpression(pattern: #"\[SEP_TEXT\]|\[P\]|\[E\]|\[DESCRIPTION\]"#)
        let nsText = text as NSString
        var cursor = 0
        var result: [Int] = []
        for match in regex.matches(in: text, range: NSRange(location: 0, length: nsText.length)) {
            if match.range.location > cursor {
                let fragment = nsText.substring(with: NSRange(location: cursor, length: match.range.location - cursor))
                result.append(contentsOf: fragment.unicodeScalars.map { Int($0.value % 32_000) + 1 })
            }
            let marker = nsText.substring(with: match.range)
            result.append(markerIds[marker]!)
            cursor = NSMaxRange(match.range)
        }
        if cursor < nsText.length {
            let fragment = nsText.substring(from: cursor)
            result.append(contentsOf: fragment.unicodeScalars.map { Int($0.value % 32_000) + 1 })
        }
        return result
    }

    @Test func schemaMarkerSlotsAndDescriptionsMatchPinnedMarkerIds() throws {
        let prepared = try EntityText.prepare(fullText: "Alice", region: EntityRegion(startUtf16: 0, endUtf16: 5),
                                             labels: labels, encode: encode, unknownTokenID: 3, maxTokens: 512)
        #expect(prepared.ids.filter { markerIds.values.contains($0) } == [250_104, 250_111, 250_106, 250_103])
        #expect(prepared.markerPositions.count == 2)
        #expect(prepared.ids[prepared.markerPositions[0]] == 250_104)
        #expect(prepared.ids[prepared.markerPositions[1]] == 250_106)
        #expect(prepared.wordOffsets == [EntityRegion(startUtf16: 0, endUtf16: 5)])
    }

    @Test func exactSlicesPreserveEmojiAndCombiningSequenceUtf16Offsets() throws {
        let text = "😀 cafe\u{301} Oslo"
        let nsText = text as NSString
        let emoji = try EntityText.exactSlice(text, startUtf16: 0, endUtf16: 2)
        let combiningStart = nsText.range(of: "cafe\u{301}").location
        let combiningEnd = NSMaxRange(nsText.range(of: "cafe\u{301}"))
        let combining = try EntityText.exactSlice(text, startUtf16: combiningStart, endUtf16: combiningEnd)
        #expect(emoji == "😀")
        #expect(combining == "cafe\u{301}")
        var rejectedSurrogateSplit = false
        do { _ = try EntityText.exactSlice(text, startUtf16: 1, endUtf16: 2) }
        catch { rejectedSurrogateSplit = true }
        #expect(rejectedSurrogateSplit)
        #expect(try EntityText.exactSlice(text, startUtf16: combiningStart, endUtf16: combiningStart + 4) == "cafe")
        #expect(try EntityText.exactSlice(text, startUtf16: combiningStart + 4, endUtf16: combiningEnd) == "\u{301}")
    }

    @Test func plannerIncludesSchemaAndOverlapsWithoutLosingCoverage() throws {
        let text = "Alice 😀 joined Northstar Lab in Oslo"
        let result = try EntityText.plan(fullText: text, labels: labels, encode: encode, unknownTokenID: 3,
                                         maxTokens: 60, overlapTokens: 5)
        #expect(result.coverage.complete)
        #expect(result.coverage.startUtf16 == 0)
        #expect(result.coverage.endUtf16 == (text as NSString).length)
        #expect(result.chunks.count > 1)
        #expect(result.chunks.allSatisfy { $0.tokenCount + $0.schemaTokenCount <= 60 && $0.schemaTokenCount > 0 })
        #expect(result.schemaTokenCount > 0)
        #expect(result.chunks.first?.startUtf16 == 0)
        #expect(result.chunks.last?.endUtf16 == (text as NSString).length)
        for adjacent in zip(result.chunks, result.chunks.dropFirst()) {
            #expect(adjacent.1.startUtf16 < adjacent.0.endUtf16, "overlap should duplicate eligible words for boundary recall")
        }
    }

    @Test func oversizedSingleRegionFailsInsteadOfSilentlyTruncating() {
        let text = Array(repeating: "internationalization", count: 40).joined(separator: " ")
        var rejected = false
        do {
            _ = try EntityText.prepare(fullText: text,
                                       region: EntityRegion(startUtf16: 0, endUtf16: (text as NSString).length),
                                       labels: labels, encode: encode, unknownTokenID: 3, maxTokens: 512)
        } catch { rejected = true }
        #expect(rejected)
    }

    @Test func unsupportedSchemaVersionIsRejectedByContractConstant() {
        #expect(entitySchemaVersion == "folio-entities-v1")
        #expect(entitySchemaVersion != "1")
    }

    @Test func pythonWordSplittingForDecomposedTextAndJoinControls() throws {
        let text = "Cafe\u{301} Ålesund 👩\u{200D}💻"
        let plan = try EntityText.plan(fullText: text, labels: labels, encode: encode, unknownTokenID: 3,
                                       maxTokens: 512, overlapTokens: 0)
        #expect(plan.chunks.count == 1)
        let prepared = try EntityText.prepare(fullText: text,
                                              region: EntityRegion(startUtf16: 0, endUtf16: (text as NSString).length),
                                              labels: labels, encode: encode, unknownTokenID: 3, maxTokens: 512)
        let pieces = prepared.wordOffsets.map { (text as NSString).substring(with: NSRange(location: $0.startUtf16, length: $0.endUtf16 - $0.startUtf16)) }
        #expect(pieces == ["Cafe", "\u{301}", "Ålesund", "👩", "\u{200D}", "💻"])
    }

    @Test func whitespacePlansCompleteCoverageWithoutInventingTextTokens() throws {
        let text = " \n\t"
        let plan = try EntityText.plan(fullText: text, labels: labels, encode: encode, unknownTokenID: 3,
                                       maxTokens: 512, overlapTokens: 0)
        #expect(plan.chunks == [EntityChunkPlan(index: 0, startUtf16: 0, endUtf16: (text as NSString).length,
                                                tokenCount: 0, schemaTokenCount: plan.schemaTokenCount)])
    }
}
