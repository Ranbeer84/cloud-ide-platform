import { HostPage } from "./host/HostPage";
import { ViewerPage } from "./viewer/ViewerPage";

export function App(): JSX.Element {
  const path = window.location.pathname;
  if (path.startsWith("/viewer")) {
    return <ViewerPage />;
  }
  return <HostPage />;
}
