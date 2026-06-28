// Root for the popped-out world map window. Renders the shared WorldMap
// component, fed by state from the main window, emitting mutations back.
// Pin drags are applied to local state optimistically for smooth movement,
// and incoming state is ignored mid-drag to avoid echo jitter.
import React, { useEffect, useRef, useState } from "react";
import WorldMap from "./WorldMap";
import {
  onWorldMapState,
  requestWorldMapState,
  emitWorldMapMutation,
  type WorldMapState,
} from "./platform/worldMapBridge";

function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve((r.result as string).split(",")[1]);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

export const WorldMapWindow: React.FC = () => {
  const [state, setState] = useState<WorldMapState | null>(null);
  const draggingRef = useRef(false);
  const dragTimerRef = useRef<number | null>(null);

  useEffect(() => {
    let unlisten: (() => void) | undefined;
    (async () => {
      unlisten = await onWorldMapState((s) => {
        // Ignore echoed state while actively dragging a pin to avoid jitter
        if (draggingRef.current) return;
        setState(s);
      });
      await requestWorldMapState();
    })();
    return () => unlisten?.();
  }, []);

  const markDragging = () => {
    draggingRef.current = true;
    if (dragTimerRef.current) window.clearTimeout(dragTimerRef.current);
    dragTimerRef.current = window.setTimeout(() => {
      draggingRef.current = false;
    }, 200);
  };

  if (!state) {
    return (
      <div style={{ height: "100vh", display: "grid", placeItems: "center", background: "var(--bg, #111)", color: "var(--text, #eee)", fontFamily: "system-ui", opacity: 0.6 }}>
        Loading world map…
      </div>
    );
  }

  return (
    <WorldMap
      imageUrl={state.imageUrl}
      worldName={state.worldName}
      worldNameCollectionId={state.worldNameCollectionId}
      worldNameEntityId={state.worldNameEntityId}
      worldMapIncludeInWiki={state.includeInWiki}
      docPins={state.docPins}
      labelPins={state.labelPins}
      documents={state.documents}
      collections={state.collections}
      onClose={() => { import("./platform/worldMapWindow").then((m) => m.closeWorldMapWindow()); }}
      onUploadImage={async (file, nameCtx) => {
        const base64 = await fileToBase64(file);
        await emitWorldMapMutation({ kind: "uploadImage", fileName: file.name, base64, nameCtx });
      }}
      onPickImagePath={(path) => emitWorldMapMutation({ kind: "setImagePath", path })}
      onRemoveImage={async () => { await emitWorldMapMutation({ kind: "removeImage" }); }}
      savedMaps={state.savedMaps}
      activeMapId={state.activeMapId}
      onMakeNewMap={() => emitWorldMapMutation({ kind: "makeNewMap" })}
      onLoadMap={(id) => emitWorldMapMutation({ kind: "loadMap", id })}
      onSelectRecord={(collectionId, entityId, name) => emitWorldMapMutation({ kind: "selectRecord", collectionId, entityId, name })}
      onClearDocPins={() => emitWorldMapMutation({ kind: "clearDocPins" })}
      onClearLabelPins={() => emitWorldMapMutation({ kind: "clearLabelPins" })}
      saveMessage={state.saveMessage}
      onSetWorldName={(name, collectionId, entityId) =>
        emitWorldMapMutation({ kind: "setWorldName", name, collectionId, entityId })
      }
      onSetIncludeInWiki={(include) => emitWorldMapMutation({ kind: "setIncludeInWiki", include })}
      onAddDocPin={(docId, x, y) => emitWorldMapMutation({ kind: "addDocPin", docId, x, y })}
      onMoveDocPin={(pinId, x, y) => {
        markDragging();
        setState((prev) => prev ? { ...prev, docPins: prev.docPins.map((p) => p.id === pinId ? { ...p, x, y } : p) } : prev);
        emitWorldMapMutation({ kind: "moveDocPin", pinId, x, y });
      }}
      onRemoveDocPin={(pinId) => emitWorldMapMutation({ kind: "removeDocPin", pinId })}
      onAddLabelPin={(collectionId, entityId, x, y) => emitWorldMapMutation({ kind: "addLabelPin", collectionId, entityId, x, y })}
      onMoveLabelPin={(pinId, x, y) => {
        markDragging();
        setState((prev) => prev ? { ...prev, labelPins: prev.labelPins.map((p) => p.id === pinId ? { ...p, x, y } : p) } : prev);
        emitWorldMapMutation({ kind: "moveLabelPin", pinId, x, y });
      }}
      onRemoveLabelPin={(pinId) => emitWorldMapMutation({ kind: "removeLabelPin", pinId })}
      onSetDocPinBorder={(pinId, border) => emitWorldMapMutation({ kind: "setDocPinBorder", pinId, border })}
      onSetLabelPinBorder={(pinId, border) => emitWorldMapMutation({ kind: "setLabelPinBorder", pinId, border })}
      onOpenDoc={(id) => {
        emitWorldMapMutation({ kind: "openDoc", docId: id });
        // The doc opens in the main window — bring it to the front so "Read more" feels responsive.
        import("./platform/worldMapWindow").then((m) => m.focusMainWindow());
      }}
      onOpenRecord={(collectionId, entityId) => {
        emitWorldMapMutation({ kind: "openRecord", collectionId, entityId });
        import("./platform/worldMapWindow").then((m) => m.focusMainWindow());
      }}
      onSave={() => emitWorldMapMutation({ kind: "save" })}
      showWikiOption={false}
    />
  );
};
