import AVFoundation
import FolioMLXAudio
import Foundation

private func require(_ condition: @autoclosure () -> Bool, _ message: String) {
    if !condition() { fatalError(message) }
}

private func makeAudio(sampleRate: Int, frames: Int, channels: Int = 1,
                       sample: (Int, Int) -> Float) throws -> URL {
    let url = FileManager.default.temporaryDirectory.appendingPathComponent("folio-audio-\(UUID().uuidString).wav")
    let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: Double(sampleRate),
                               channels: AVAudioChannelCount(channels), interleaved: false)!
    let file = try AVAudioFile(forWriting: url, settings: format.settings)
    let windowSize = 4096
    var offset = 0
    while offset < frames {
        let count = min(windowSize, frames - offset)
        let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(count))!
        buffer.frameLength = AVAudioFrameCount(count)
        for channel in 0..<channels {
            for frame in 0..<count { buffer.floatChannelData![channel][frame] = sample(channel, offset + frame) }
        }
        try file.write(from: buffer)
        offset += count
    }
    return url
}

private func makeSparseAudio(sampleRate: UInt32, durationSeconds: UInt32, channels: UInt16) throws -> URL {
    func appendLE<T: FixedWidthInteger>(_ value: T, to data: inout Data) {
        var littleEndian = value.littleEndian
        withUnsafeBytes(of: &littleEndian) { data.append(contentsOf: $0) }
    }

    let frameCount = sampleRate * durationSeconds
    let dataSize = frameCount * UInt32(channels) * 2
    var header = Data("RIFF".utf8)
    appendLE(dataSize + 36, to: &header)
    header.append(contentsOf: "WAVEfmt ".utf8)
    appendLE(UInt32(16), to: &header)
    appendLE(UInt16(1), to: &header) // PCM
    appendLE(channels, to: &header)
    appendLE(sampleRate, to: &header)
    appendLE(sampleRate * UInt32(channels) * 2, to: &header)
    appendLE(channels * 2, to: &header)
    appendLE(UInt16(16), to: &header)
    header.append(contentsOf: "data".utf8)
    appendLE(dataSize, to: &header)

    let url = FileManager.default.temporaryDirectory.appendingPathComponent("folio-sparse-audio-\(UUID().uuidString).wav")
    FileManager.default.createFile(atPath: url.path, contents: header)
    let handle = try FileHandle(forWritingTo: url)
    try handle.truncate(atOffset: UInt64(header.count) + UInt64(dataSize))
    try handle.close()
    return url
}

@main
private struct AudioWindowReaderTests {
    static func main() throws {
        try readsShortExactAndTrailingWindowsInOrderWithoutDroppingFrames()
        try keepsFirstChannelAndBounds15And60MinuteSourcesByWindow()
        try rejectsInvalidWindowDuration()
        print("AudioWindowReader tests passed.")
    }

    static func readsShortExactAndTrailingWindowsInOrderWithoutDroppingFrames() throws {
        let sampleRate = 48_000
        let windowFrames = sampleRate * 30
        for frames in [5, windowFrames, windowFrames + 5] {
            let url = try makeAudio(sampleRate: sampleRate, frames: frames) { _, index in Float(index) }
            defer { try? FileManager.default.removeItem(at: url) }
            let reader = try AudioWindowReader(url: url)
            var actual: [Float] = []
            var sizes: [Int] = []
            while let window = try reader.nextWindow() {
                sizes.append(window.samples.count)
                actual.append(contentsOf: window.samples)
                require(window.completedFrames == Int64(actual.count), "source frame progress skipped or repeated frames")
                require(window.totalFrames == Int64(frames), "reported total source frames changed")
            }
            require(actual == (0..<frames).map(Float.init), "decoded windows changed sample order or dropped frames")
            let afterEnd = try reader.nextWindow()
            require(afterEnd.map { _ in false } ?? true, "reader returned data after EOF")
            require(sizes.allSatisfy { $0 <= windowFrames }, "short and trailing windows exceeded their frame limit")
        }
    }

    static func keepsFirstChannelAndBounds15And60MinuteSourcesByWindow() throws {
        let sampleRate = 48_000
        let channelURL = try makeAudio(sampleRate: sampleRate, frames: 128, channels: 2) { channel, index in
            channel == 0 ? Float(index) : -Float(index)
        }
        defer { try? FileManager.default.removeItem(at: channelURL) }
        let channelReader = try AudioWindowReader(url: channelURL)
        let channelWindow = try channelReader.nextWindow()
        require(channelWindow?.samples == (0..<128).map(Float.init), "reader did not preserve the upstream first channel")

        for durationSeconds in [15 * 60, 60 * 60] {
            let frames = sampleRate * durationSeconds
            let url = try makeSparseAudio(sampleRate: UInt32(sampleRate), durationSeconds: UInt32(durationSeconds), channels: 2)
            defer { try? FileManager.default.removeItem(at: url) }
            let reader = try AudioWindowReader(url: url)
            require(reader.sampleRate == sampleRate, "reader changed the source sample rate")
            let maximumWindowFrames = reader.sampleRate * 30
            var windows = 0
            var completed: Int64 = 0
            while let window = try reader.nextWindow() {
                require(window.samples.count <= maximumWindowFrames, "source window exceeded 30 seconds")
                require(window.completedFrames > completed, "reader failed to advance source frames")
                completed = window.completedFrames
                windows += 1
            }
            require(completed == Int64(frames), "15/60 minute source ended before its final frame")
            require(windows == durationSeconds / 30, "reader did not use a fixed 30-second bound")
        }
    }

    static func rejectsInvalidWindowDuration() throws {
        let url = try makeAudio(sampleRate: 48_000, frames: 1) { _, _ in 0 }
        defer { try? FileManager.default.removeItem(at: url) }
        do {
            _ = try AudioWindowReader(url: url, windowSeconds: 0)
            fatalError("zero-second window duration was accepted")
        } catch { }
    }

}
