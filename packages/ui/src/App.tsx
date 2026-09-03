import { useEffect, useMemo, useState } from "react";
import { useLiveData } from "./api";
import { CallDetailPanel } from "./components/CallDetail";
import { SessionList } from "./components/SessionList";
import { SessionView } from "./components/SessionView";

type Theme = "dark" | "light";

function initialTheme(): Theme {
  try {
    const saved = localStorage.getItem("mcpwatch-theme");
    if (saved === "dark" || saved === "light") return saved;
  } catch {
    /* private mode etc. */
  }
  return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function App(): JSX.Element {
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [selectedCallId, setSelectedCallId] = useState<number | null>(null);
  const [autoSelected, setAutoSelected] = useState(false);
  const [theme, setTheme] = useState<Theme>(initialTheme);
  const [now, setNow] = useState(() => Date.now());

  const { sessions, detail, live, loaded } = useLiveData(selectedId);

  // Pick the most recent session on first load so the screen is never empty.
  useEffect(() => {
    if (!autoSelected && sessions.length > 0) {
      setAutoSelected(true);
      setSelectedId(sessions[0]!.id);
    }
  }, [autoSelected, sessions]);

  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem("mcpwatch-theme", theme);
    } catch {
      /* ignore */
    }
  }, [theme]);

  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 30_000);
    return () => clearInterval(t);
  }, []);

  const selectSession = (id: string): void => {
    setSelectedId(id);
    setSelectedCallId(null);
  };

  const running = useMemo(() => sessions.filter((s) => s.ended_at === null).length, [sessions]);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <span className="brand-mark" aria-hidden />
          mcpwatch
        </div>
        <div className={`live-pill ${live ? "is-live" : "is-off"}`}>
          <span className="live-dot" aria-hidden />
          {live ? (running > 0 ? `live · ${running} running` : "live") : "reconnecting…"}
        </div>
        <div className="topbar-spacer" />
        <button
          className="ghost-btn"
          onClick={() => setTheme(theme === "dark" ? "light" : "dark")}
          title="Toggle theme"
        >
          {theme === "dark" ? "☀" : "☾"}
        </button>
      </header>

      <div className={`columns ${selectedCallId !== null ? "with-detail" : ""}`}>
        <SessionList sessions={sessions} selectedId={selectedId} onSelect={selectSession} now={now} loaded={loaded} />
        <SessionView
          detail={detail}
          now={now}
          selectedCallId={selectedCallId}
          onSelectCall={setSelectedCallId}
        />
        {selectedCallId !== null && (
          <CallDetailPanel callId={selectedCallId} onClose={() => setSelectedCallId(null)} />
        )}
      </div>
    </div>
  );
}
