import { render } from "preact";
import { App } from "./app";

const root = document.getElementById("app");
if (root) {
  // Build id of the document that is actually loaded, for on-device checks
  // after a service worker update.
  const buildId = document
    .querySelector('meta[name="build-id"]')
    ?.getAttribute("content");
  if (buildId) {
    document.documentElement.dataset.buildId = buildId;
  }
  render(<App />, root);
}
