import { useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { LiveMarkdownEditor } from "./LiveMarkdownEditor.tsx";

type DraftMarkdownEditorProps = {
  value: string;
  onChange: (value: string) => void;
  onFile: () => void;
  ariaLabel: string;
};

const steeringPlaceholder =
  "Optional: steer the title or path here. Press Enter to let the agent decide.";

/**
 * Keeps the untitled-note steering affordance around the same editor used for
 * filed notes. The first source line remains in the dark steering band while
 * all inactive lines receive the live Markdown treatment.
 */
export function DraftMarkdownEditor({
  value,
  onChange,
  onFile,
  ariaLabel,
}: DraftMarkdownEditorProps) {
  const shellRef = useRef<HTMLDivElement>(null);
  const measureRef = useRef<HTMLDivElement>(null);
  const [steeringHeight, setSteeringHeight] = useState(0);
  const firstLine = value.split("\n", 1)[0];
  const measuredFirstLine = firstLine || (!value ? steeringPlaceholder : " ");

  useLayoutEffect(() => {
    const shell = shellRef.current;
    const measure = measureRef.current;
    if (!shell || !measure) return;
    const updateHeight = () =>
      setSteeringHeight(Math.ceil(measure.getBoundingClientRect().height));
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(shell);
    return () => observer.disconnect();
  }, [measuredFirstLine]);

  return (
    <div
      className="draft-note-editor"
      ref={shellRef}
      style={
        { "--steering-height": `${steeringHeight}px` } as CSSProperties
      }
    >
      <div className="draft-steering-band" />
      <div
        className="draft-steering-measure"
        ref={measureRef}
        aria-hidden="true"
      >
        {measuredFirstLine}
      </div>
      {!value && (
        <span className="draft-steering-placeholder" aria-hidden="true">
          {steeringPlaceholder}
        </span>
      )}
      <LiveMarkdownEditor
        value={value}
        onChange={onChange}
        onFile={onFile}
        autoFocus
        ariaLabel={ariaLabel}
      />
    </div>
  );
}
