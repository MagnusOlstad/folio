import AVFoundation
import Foundation

public struct AudioWindow: Sendable {
    public let samples: [Float]
    public let completedFrames: Int64
    public let totalFrames: Int64
}

/// Reads mono samples from the first channel without retaining the whole recording.
public final class AudioWindowReader {
    public static let defaultWindowSeconds = 30

    private let file: AVAudioFile
    private let sourceSampleRate: Int
    private let windowFrameLimit: Int64
    public let totalFrames: Int64
    public private(set) var completedFrames: Int64 = 0

    public init(url: URL, windowSeconds: Int = defaultWindowSeconds) throws {
        guard windowSeconds > 0 else {
            throw NSError(domain: "FolioMLXAudio", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "Audio window duration must be positive."])
        }
        let file = try AVAudioFile(forReading: url)
        let sampleRate = Int(file.processingFormat.sampleRate)
        guard sampleRate > 0 else {
            throw NSError(domain: "FolioMLXAudio", code: 2,
                          userInfo: [NSLocalizedDescriptionKey: "The audio file has an invalid sample rate."])
        }
        self.file = file
        self.sourceSampleRate = sampleRate
        self.totalFrames = file.length
        self.windowFrameLimit = Int64(sampleRate) * Int64(windowSeconds)
    }

    public func nextWindow() throws -> AudioWindow? {
        guard completedFrames < totalFrames else { return nil }
        let frameCount = min(windowFrameLimit, totalFrames - completedFrames)
        let result = try autoreleasepool { () throws -> (samples: [Float], count: Int) in
            guard let buffer = AVAudioPCMBuffer(pcmFormat: file.processingFormat,
                                                frameCapacity: AVAudioFrameCount(frameCount)) else {
                throw NSError(domain: "FolioMLXAudio", code: 3,
                              userInfo: [NSLocalizedDescriptionKey: "Could not allocate an audio window."])
            }
            try file.read(into: buffer, frameCount: AVAudioFrameCount(frameCount))
            let actualFrames = Int(buffer.frameLength)
            guard actualFrames > 0, let channels = buffer.floatChannelData else {
                throw NSError(domain: "FolioMLXAudio", code: 4,
                              userInfo: [NSLocalizedDescriptionKey: "Could not read audio samples."])
            }
            return (Array(UnsafeBufferPointer(start: channels[0], count: actualFrames)), actualFrames)
        }
        let samples = result.samples
        let actualFrames = result.count
        completedFrames += Int64(actualFrames)
        return AudioWindow(samples: samples, completedFrames: completedFrames, totalFrames: totalFrames)
    }

    public var sampleRate: Int { sourceSampleRate }
}
