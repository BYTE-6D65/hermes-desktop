import { useState, useEffect, useCallback } from "react";
import { ThemeProvider } from "./components/ThemeProvider";
import ErrorBoundary from "./components/ErrorBoundary";
import Welcome from "./screens/Welcome/Welcome";
import Install from "./screens/Install/Install";
import Setup from "./screens/Setup/Setup";
import Layout from "./screens/Layout/Layout";
import { useI18n } from "./components/useI18n";

type Screen = "loading" | "welcome" | "installing" | "setup" | "main";

function App(): React.JSX.Element {
  const { t } = useI18n();
  const [screen, setScreen] = useState<Screen>("loading");
  const [installError, setInstallError] = useState<string | null>(null);
  const isMac = window.electron?.process?.platform === "darwin";

  const runInstallCheck = useCallback(async () => {
    let next: Screen = "welcome";
    let error: string | null = null;
    let isRemote = false;

    try {
      const conn = await window.hermesAPI.getConnectionConfig();
      isRemote = conn.mode === "remote" || conn.mode === "ssh";

      if (conn.mode === "ssh" && conn.ssh) {
        try {
          await window.hermesAPI.startSshTunnel();
          next = "main";
        } catch (tunnelErr) {
          error = `SSH tunnel failed to start: ${(tunnelErr as Error).message}`;
          next = "welcome";
        }
      } else if (conn.mode === "remote" && conn.remoteUrl) {
        const ok = await window.hermesAPI.testRemoteConnection(
          conn.remoteUrl,
          conn.apiKey,
        );
        if (ok) {
          next = "main";
        } else {
          error = `Cannot reach remote Hermes at ${conn.remoteUrl}. Check the URL or switch to local mode.`;
          next = "welcome";
        }
      } else {
        const status = await window.hermesAPI.checkInstall();
        if (!status.installed) {
          next = "welcome";
        } else if (!status.hasApiKey) {
          next = "setup";
        } else {
          next = "main";
        }
      }
    } catch {
      next = "welcome";
    }

    if (error) setInstallError(error);
    setScreen(next);

    // Lazy deep-verify in the background after the UI is up.
    if ((next === "main" || next === "setup") && !isRemote) {
      window.hermesAPI.verifyInstall().then((ok) => {
        if (!ok) {
          setInstallError(t("errors.installBroken"));
          setScreen("welcome");
        }
      });
    }
  }, [t]);

  useEffect(() => {
    runInstallCheck();
  }, [runInstallCheck]);

  function handleInstallComplete(): void {
    setInstallError(null);
    setScreen("setup");
  }

  function handleInstallFailed(error: string): void {
    setInstallError(error);
    setScreen("welcome");
  }

  function handleRetryInstall(): void {
    setInstallError(null);
    setScreen("installing");
  }

  function handleRecheck(): void {
    setInstallError(null);
    setScreen("loading");
    runInstallCheck();
  }

  function renderScreen(): React.JSX.Element {
    switch (screen) {
      case "loading":
        return <div />; // blank while checking, no branded splash
      case "welcome":
        return (
          <Welcome
            error={installError}
            onStart={handleRetryInstall}
            onRecheck={handleRecheck}
          />
        );
      case "installing":
        return (
          <Install
            onComplete={handleInstallComplete}
            onFailed={handleInstallFailed}
          />
        );
      case "setup":
        return <Setup onComplete={() => setScreen("main")} />;
      case "main":
        return <Layout />;
    }
  }

  return (
    <ThemeProvider>
      <ErrorBoundary>
        <div className="app">
          {isMac && <div className="drag-region" />}
          <div className="app-content">{renderScreen()}</div>
        </div>
      </ErrorBoundary>
    </ThemeProvider>
  );
}

export default App;
