import { useEffect, useState } from "react";
import type { DesktopUpdateState } from "../../../domain/types.ts";

export function useDesktopUpdateState() {
  const [updateState, setUpdateState] = useState<DesktopUpdateState | null>(null);
  useEffect(() => {
    let receivedEvent = false;
    let mounted = true;
    const unsubscribe = window.folio?.onUpdateState?.((state) => {
      receivedEvent = true;
      setUpdateState(state);
    });
    const getUpdateState = window.folio?.getUpdateState;
    if (getUpdateState) {
      void Promise.resolve().then(getUpdateState).then((state) => {
        if (mounted && !receivedEvent && state) setUpdateState(state);
      }).catch(() => {});
    }
    return () => {
      mounted = false;
      unsubscribe?.();
    };
  }, []);

  return updateState;
}
