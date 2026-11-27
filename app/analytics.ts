// The app's one NsMetry client (https://nsmetry.huacnlee-account.workers.dev, site "noop").
// Only screen names and the app version leave the device, with a random install id kept in Storage
// under "nsmetry.uid": no email, hub address, task, channel or message content.
import { signal } from "nsh";
import { createNsMetry } from "nsmetry";
import { CLIENT_VERSION } from "./version";

export const nsmetry = createNsMetry({
  endpoint: "https://nsmetry.huacnlee-account.workers.dev",
  site: "noop",
  persistUserId: true,
  // Release builds write the version into version.ts; a dev build reports "dev".
  appVersion: CLIENT_VERSION,
});

/** The page the signed-in app shows, as a path without ids ("/task", not "/task/T-1"); set by the chat view. */
export const chatScreen = signal<string | null>(null);
