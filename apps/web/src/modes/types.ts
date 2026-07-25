import type { RelayPrivateTask, WordOption } from "@draw-guess/protocol";
import type { LocalContentServices, WordPoolUpload } from "@draw-guess/content";
import type { PublicRoomSnapshot } from "@draw-guess/shared-types";

export interface GameAsset {
  mimeType: "image/png" | "image/jpeg" | "image/webp";
  bytes: Uint8Array;
}

export interface ActualHostControls {
  pause: (roomCode: string) => Promise<void>;
  resume: (roomCode: string) => Promise<void>;
  replay?: {
    retry: (roomCode: string) => Promise<{ path: string; byteLength: number }>;
    saved: (roomCode: string) => Promise<{ path: string; byteLength: number } | null>;
    openFile: (roomCode: string) => Promise<void>;
    openFolder: (roomCode: string) => Promise<void>;
  };
}

export interface ModeViewProps {
  snapshot: PublicRoomSnapshot;
  send: (message: Record<string, unknown>) => void;
  serverOffset: number;
  frameUrl: string | null;
  wordOptions: WordOption[];
  wordOptionsActorStepId: string | null;
  currentWord: string | null;
  avatarUrls: ReadonlyMap<string, string>;
  content: LocalContentServices;
  uploadWordPool: (wordPool: WordPoolUpload) => Promise<void>;
  uploadReference: (file: File) => Promise<{
    revision: string;
    mimeType: "image/png" | "image/jpeg" | "image/webp";
    width: number;
    height: number;
    byteLength: number;
  }>;
  deleteReference: () => Promise<void>;
  loadAsset: (path: string) => Promise<GameAsset>;
  loadRelayTask: (actorStepId: string) => Promise<RelayPrivateTask>;
  onManageWords: () => void;
  notify: (message: string) => void;
  hostControls?: ActualHostControls;
}
