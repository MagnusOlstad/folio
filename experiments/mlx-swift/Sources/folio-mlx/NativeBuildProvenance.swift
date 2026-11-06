enum NativeBuildProvenance {
    static let revision = "unknown"
    static let dirty = true
}

let nativeRuntimeRevision = NativeBuildProvenance.revision
let nativeRuntimeDirty = NativeBuildProvenance.dirty
