import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TranscriptionDock } from "../../src/features/transcription/components/TranscriptionDock.tsx";
import { mergeTranscriptionDraft } from "../../src/features/transcription/model/types.ts";
import type {
  TranscriptionDockActions,
  TranscriptionDockModel,
} from "../../src/features/transcription/hooks/useTranscription.ts";

function model(overrides: Partial<TranscriptionDockModel> = {}): TranscriptionDockModel {
  return {
    phase: "idle",
    elapsedMs: 0,
    activeSession: null,
    pending: [],
    systemAudio: false,
    fallbackMessage: "",
    bridgeAvailable: true,
    status: null,
    error: "",
    ...overrides,
  };
}

function actions(): TranscriptionDockActions {
  return {
    start: vi.fn(),
    stop: vi.fn(),
    transcribe: vi.fn(),
    transcribePending: vi.fn(),
    later: vi.fn(),
    retry: vi.fn(),
    revealModelFolder: vi.fn(),
  };
}

describe("transcription UI", () => {
  it("preserves the steering line and user notes while adding result sections", () => {
    expect(mergeTranscriptionDraft("# Meeting\nKeep this note", {
      summary: "A short summary.",
      transcript: "Hello from the transcript.",
    })).toBe(
      "# Meeting\n\n# Notes\n\nKeep this note\n\n# Summary\n\nA short summary.\n\n# Transcript\n\nHello from the transcript.\n",
    );
  });

  it("explains browser absence instead of attempting to record", () => {
    const dockActions = actions();
    render(<TranscriptionDock model={model({ bridgeAvailable: false })} actions={dockActions} />);
    expect(screen.getByRole("button", { name: "Record" })).toBeDisabled();
    expect(screen.getByText(/desktop app/i)).toBeInTheDocument();
  });

  it("shows the stop prompt and routes both choices", () => {
    const dockActions = actions();
    const { rerender } = render(
      <TranscriptionDock
        model={model({ phase: "recording", elapsedMs: 61_000, systemAudio: true })}
        actions={dockActions}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    expect(dockActions.stop).toHaveBeenCalledOnce();
    rerender(<TranscriptionDock model={model({ phase: "stopped", elapsedMs: 61_000 })} actions={dockActions} />);
    fireEvent.click(screen.getByRole("button", { name: "Transcribe now" }));
    fireEvent.click(screen.getByRole("button", { name: "Later" }));
    expect(dockActions.transcribe).toHaveBeenCalledOnce();
    expect(dockActions.later).toHaveBeenCalledOnce();
  });

  it("keeps recording available while exposing missing model guidance", () => {
    const dockActions = actions();
    render(
      <TranscriptionDock
        model={model({
          status: {
            available: true,
            runtime: "ready",
            model: "missing",
            ollama: "online",
            ollamaModel: "ready",
            whisperPath: null,
            modelPath: null,
          },
        })}
        actions={dockActions}
      />,
    );
    expect(screen.getByRole("button", { name: "Record" })).toBeEnabled();
    fireEvent.click(screen.getByRole("button", { name: "Reveal Whisper model folder" }));
    expect(dockActions.revealModelFolder).toHaveBeenCalledOnce();
  });
});
