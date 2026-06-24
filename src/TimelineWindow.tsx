// Root for the popped-out timeline window. Renders the shared Timeline
// component, fed by state from the main window, emitting mutations back.
import React, { useEffect, useState } from "react";
import Timeline from "./Timeline";
import {
  onTimelineState,
  requestTimelineState,
  emitTimelineMutation,
  type TimelineState,
} from "./platform/timelineBridge";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const TimelineWindow: React.FC = () => {
  const [state, setState] = useState<TimelineState | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await onTimelineState(setState);
      await requestTimelineState();
    })();
    return () => unlisten?.();
  }, []);

  if (!state) {
    return (
      <div style={{ height: "100vh", display: "grid", placeItems: "center", background: "var(--bg, #111)", color: "var(--text, #eee)", fontFamily: "system-ui", opacity: 0.6 }}>
        Loading timeline…
      </div>
    );
  }

  return (
    <div style={{ height: "100vh", display: "flex", flexDirection: "column", background: "var(--bg-surface, #111)", color: "var(--text, #eee)" }}>
      <Timeline
        enabled
        bare
        documents={state.documents}
        collections={state.collections}
        labels={state.labels as any}
        beatCount={state.beatCount}
        timelineCovers={state.covers}
        sectionTitles={state.sectionTitles ?? {}}
        onRenameSection={(beat, title) => emitTimelineMutation({ kind: "renameSection", beat, title })}
        onInsertBeat={(beat) => emitTimelineMutation({ kind: "insertBeat", beat })}
        onRemoveBeat={(beat) => emitTimelineMutation({ kind: "removeBeat", beat })}
        onMoveDoc={(docId, position) => emitTimelineMutation({ kind: "moveDoc", docId, position })}
        onOpenDoc={(docId) => emitTimelineMutation({ kind: "openDoc", docId })}
        onAddEntityLabel={(position, collectionId, entityId) =>
          emitTimelineMutation({ kind: "addEntityLabel", position, collectionId, entityId })
        }
        onDeleteLabel={(labelId) => emitTimelineMutation({ kind: "deleteLabel", labelId })}
        onUploadCover={async (beat, file) => {
          const base64 = await fileToBase64(file);
          emitTimelineMutation({ kind: "uploadCover", beat, fileName: file.name, base64 });
        }}
        onRemoveCover={(beat) => emitTimelineMutation({ kind: "removeCover", beat })}
        onSelectEntity={(collectionId, entityId) =>
          emitTimelineMutation({ kind: "selectEntity", collectionId, entityId })
        }
      />
    </div>
  );
};
