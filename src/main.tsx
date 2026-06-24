import React from "react";
import ReactDOM from "react-dom/client";
import { AuthGate } from "./AuthGate";
import { AppModalProvider } from "./AppModal";
import { TimelineWindow } from "./TimelineWindow";
import { isTimelineView } from "./platform/timelineWindow";
import { WorldMapWindow } from "./WorldMapWindow";
import { isWorldMapView } from "./platform/worldMapWindow";
import "./index.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

if (isTimelineView()) {
  root.render(
    <React.StrictMode>
      <AppModalProvider>
        <TimelineWindow />
      </AppModalProvider>
    </React.StrictMode>
  );
} else if (isWorldMapView()) {
  root.render(
    <React.StrictMode>
      <AppModalProvider>
        <WorldMapWindow />
      </AppModalProvider>
    </React.StrictMode>
  );
} else {
  root.render(
    <React.StrictMode>
      <AppModalProvider>
        <AuthGate />
      </AppModalProvider>
    </React.StrictMode>
  );
}
