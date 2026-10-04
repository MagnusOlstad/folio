import Foundation
import XCTest
@testable import FolioMLXProgress

final class DownloadProgressBytesTests: XCTestCase {
    func testParentFractionIncludesPartiallyDownloadedChildBytes() {
        let parent = Progress(totalUnitCount: 1_000)
        let child = Progress(totalUnitCount: 1_000, parent: parent, pendingUnitCount: 1_000)

        child.completedUnitCount = 500

        XCTAssertEqual(parent.completedUnitCount, 0)
        XCTAssertEqual(parent.fractionCompleted, 0.5)
        XCTAssertEqual(DownloadProgressBytes.downloadedBytes(for: parent), 500)
    }

    func testParentFractionWeightsMultipleShardsByTheirByteSizes() {
        let parent = Progress(totalUnitCount: 3_000)
        let largeShard = Progress(totalUnitCount: 2_000, parent: parent, pendingUnitCount: 2_000)
        let smallShard = Progress(totalUnitCount: 1_000, parent: parent, pendingUnitCount: 1_000)

        largeShard.completedUnitCount = 1_000
        smallShard.completedUnitCount = 500

        XCTAssertEqual(parent.fractionCompleted, 0.5)
        XCTAssertEqual(DownloadProgressBytes.downloadedBytes(for: parent), 1_500)
    }

    func testDirectProgressUsesItsByteCountAndRejectsMissingTotals() {
        let progress = Progress(totalUnitCount: 8_000)
        progress.completedUnitCount = 2_000

        XCTAssertEqual(DownloadProgressBytes.downloadedBytes(for: progress), 2_000)
        XCTAssertNil(DownloadProgressBytes.downloadedBytes(for: Progress(totalUnitCount: 0)))
    }

    func testCompletedParentReportsItsFullTotal() {
        let parent = Progress(totalUnitCount: 1_000)
        let child = Progress(totalUnitCount: 1_000, parent: parent, pendingUnitCount: 1_000)
        child.completedUnitCount = 1_000

        XCTAssertEqual(DownloadProgressBytes.downloadedBytes(for: parent), 1_000)
    }

    func testFractionIsClampedAndInt64MaximumDoesNotOverflow() {
        let negative = Progress(totalUnitCount: 1_000)
        negative.completedUnitCount = -50
        XCTAssertEqual(DownloadProgressBytes.downloadedBytes(for: negative), 0)

        let overrun = Progress(totalUnitCount: 1_000)
        overrun.completedUnitCount = 1_200
        XCTAssertEqual(DownloadProgressBytes.downloadedBytes(for: overrun), 1_000)

        let maximum = Progress(totalUnitCount: Int64.max)
        maximum.completedUnitCount = Int64.max
        XCTAssertEqual(DownloadProgressBytes.downloadedBytes(for: maximum), Int64.max)
    }
}
