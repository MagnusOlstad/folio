import Foundation

public enum DownloadProgressBytes {
    public static func downloadedBytes(for progress: Progress) -> Int64? {
        let totalBytes = progress.totalUnitCount
        let fractionCompleted = progress.fractionCompleted
        guard totalBytes > 0, fractionCompleted.isFinite else { return nil }

        if fractionCompleted <= 0 { return 0 }
        if fractionCompleted >= 1 { return totalBytes }

        let scaledBytes = Double(totalBytes) * fractionCompleted
        guard scaledBytes < Double(Int64.max) else { return totalBytes }
        return Int64(scaledBytes.rounded(.down))
    }
}
