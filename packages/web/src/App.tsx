import { AuthProvider } from "./auth/AuthContext";
import { HostPage } from "./host/HostPage";
import { ViewerPage } from "./viewer/ViewerPage";

export function App(): JSX.Element {
  const path = window.location.pathname;
  if (path.startsWith("/viewer")) {
    // Viewers join with a session code and need no account.
    return <ViewerPage />;
  }
  return (
    <AuthProvider>
      <HostPage />
    </AuthProvider>
  );
}