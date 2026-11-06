import Testing
@testable import FolioMLXEntities

@Suite struct DebertaTests {
    @Test func relativePositionSignsMatchPinnedMLXVLMReference() {
        #expect(relativePositionMatrix(3, buckets: 256, maximum: -1) ==
                [[0, -1, -2], [1, 0, -1], [2, 1, 0]])
    }
}
