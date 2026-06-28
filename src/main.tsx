import React from "react";
import ReactDOM from "react-dom/client";
import { AuthGate } from "./AuthGate";
import { AppModalProvider } from "./AppModal";
import { LanguageProvider } from "./i18n";
import { TimelineWindow } from "./TimelineWindow";
import { isTimelineView } from "./platform/timelineWindow";
import { WorldMapWindow } from "./WorldMapWindow";
import { isWorldMapView } from "./platform/worldMapWindow";
import "./index.css";

const root = ReactDOM.createRoot(document.getElementById("root") as HTMLElement);

const view = isTimelineView() ? <TimelineWindow /> : isWorldMapView() ? <WorldMapWindow /> : <AuthGate />;

root.render(
  <React.StrictMode>
    <LanguageProvider>
      <AppModalProvider>
        {view}
      </AppModalProvider>
    </LanguageProvider>
  </React.StrictMode>
);
