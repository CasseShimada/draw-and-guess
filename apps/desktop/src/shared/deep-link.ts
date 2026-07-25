import { InviteSchema, type Invite } from "./ipc.js";
import { normalizeServerUrl } from "./server-url.js";

const ALLOWED_PARAMETERS = new Set(["server", "room"]);

export function parseInviteArguments(argumentsList: readonly string[]): Invite | null {
  const candidate = argumentsList.find((argument) =>
    argument.toLowerCase().startsWith("drawguess://")
  );
  if (!candidate) {
    return null;
  }
  try {
    const parsed = new URL(candidate);
    if (
      parsed.protocol !== "drawguess:" ||
      (parsed.host !== "join" && parsed.pathname !== "/join") ||
      parsed.hash ||
      [...parsed.searchParams.keys()].some((key) => !ALLOWED_PARAMETERS.has(key)) ||
      parsed.searchParams.getAll("server").length !== 1 ||
      parsed.searchParams.getAll("room").length !== 1
    ) {
      return null;
    }
    const serverUrl = normalizeServerUrl(parsed.searchParams.get("server") ?? "");
    const roomCode = (parsed.searchParams.get("room") ?? "").toUpperCase();
    return InviteSchema.parse({ serverUrl, roomCode });
  } catch {
    return null;
  }
}
