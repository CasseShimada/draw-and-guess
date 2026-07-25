import {
  BUILTIN_WORD_PACK,
  CONTENT_LIMITS,
  LocalAvatarSchema,
  WordPackFileSchema,
  WordPackSelectionSchema,
  sanitizeExportFilename,
  serializeWordPack,
  summarizeWordPack,
  validateAvatarInputPng,
  validateNormalizedAvatarPng,
  type LocalAvatar,
  type LocalContentServices,
  type WordPackFile,
  type WordPackSelection,
  type WordPackSummary
} from "@draw-guess/content";

const DATABASE_NAME = "draw-guess-content";
const DATABASE_VERSION = 1;
const WORD_PACKS_STORE = "wordPacks";
const PROFILE_STORE = "profile";
const PREFERENCES_STORE = "preferences";
const ACTIVE_AVATAR_KEY = "activeAvatar";
const WORD_SELECTION_KEY = "wordSelection";

function requestResult<T>(request: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    request.addEventListener("success", () => resolve(request.result), {
      once: true
    });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("IndexedDB 请求失败")),
      { once: true }
    );
  });
}

function transactionDone(transaction: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    transaction.addEventListener("complete", () => resolve(), { once: true });
    transaction.addEventListener(
      "abort",
      () => reject(transaction.error ?? new Error("IndexedDB 事务已中止")),
      { once: true }
    );
    transaction.addEventListener(
      "error",
      () => reject(transaction.error ?? new Error("IndexedDB 事务失败")),
      { once: true }
    );
  });
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const digest = await crypto.subtle.digest("SHA-256", buffer);
  return [...new Uint8Array(digest)]
    .map((value) => value.toString(16).padStart(2, "0"))
    .join("");
}

function openDatabase(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.addEventListener("upgradeneeded", () => {
      const database = request.result;
      if (!database.objectStoreNames.contains(WORD_PACKS_STORE)) {
        database.createObjectStore(WORD_PACKS_STORE, { keyPath: "id" });
      }
      if (!database.objectStoreNames.contains(PROFILE_STORE)) {
        database.createObjectStore(PROFILE_STORE);
      }
      if (!database.objectStoreNames.contains(PREFERENCES_STORE)) {
        database.createObjectStore(PREFERENCES_STORE);
      }
    });
    request.addEventListener("success", () => resolve(request.result), {
      once: true
    });
    request.addEventListener(
      "error",
      () => reject(request.error ?? new Error("无法打开本地内容数据库")),
      { once: true }
    );
  });
}

class BrowserWordPackStore {
  async list(): Promise<WordPackSummary[]> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(WORD_PACKS_STORE, "readonly");
      const values = await requestResult(
        transaction.objectStore(WORD_PACKS_STORE).getAll()
      );
      await transactionDone(transaction);
      return values.flatMap((value) => {
        const parsed = WordPackFileSchema.safeParse(value);
        return parsed.success ? [summarizeWordPack(parsed.data)] : [];
      });
    } finally {
      database.close();
    }
  }

  async get(id: string): Promise<WordPackFile | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(WORD_PACKS_STORE, "readonly");
      const value = await requestResult<unknown>(
        transaction.objectStore(WORD_PACKS_STORE).get(id) as IDBRequest<unknown>
      );
      await transactionDone(transaction);
      const parsed = WordPackFileSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    } finally {
      database.close();
    }
  }

  async put(packInput: WordPackFile): Promise<void> {
    const pack = WordPackFileSchema.parse(packInput);
    serializeWordPack(pack);
    if (pack.id === BUILTIN_WORD_PACK.id) {
      throw new Error("内置基础词库是只读的，请先复制");
    }
    const summaries = await this.list();
    if (
      !summaries.some((summary) => summary.id === pack.id) &&
      summaries.length >= CONTENT_LIMITS.localWordPacks
    ) {
      throw new Error("本机最多保存 200 个用户词库包");
    }
    const database = await openDatabase();
    try {
      const transaction = database.transaction(WORD_PACKS_STORE, "readwrite");
      transaction.objectStore(WORD_PACKS_STORE).put(pack);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async remove(id: string): Promise<void> {
    if (id === BUILTIN_WORD_PACK.id) {
      throw new Error("内置基础词库不能删除");
    }
    const database = await openDatabase();
    try {
      const transaction = database.transaction(WORD_PACKS_STORE, "readwrite");
      transaction.objectStore(WORD_PACKS_STORE).delete(id);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }
}

class BrowserAvatarStore {
  async getActive(): Promise<LocalAvatar | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PROFILE_STORE, "readonly");
      const value = await requestResult<unknown>(
        transaction
          .objectStore(PROFILE_STORE)
          .get(ACTIVE_AVATAR_KEY) as IDBRequest<unknown>
      );
      await transactionDone(transaction);
      const parsed = LocalAvatarSchema.safeParse(value);
      if (!parsed.success) {
        return null;
      }
      try {
        validateNormalizedAvatarPng(parsed.data.bytes);
        if ((await sha256(parsed.data.bytes)) !== parsed.data.sha256) {
          return null;
        }
        if (parsed.data.source) {
          const sourceInfo = validateAvatarInputPng(parsed.data.source.bytes);
          if (
            sourceInfo.width !== parsed.data.source.width ||
            sourceInfo.height !== parsed.data.source.height ||
            (await sha256(parsed.data.source.bytes)) !== parsed.data.source.sha256
          ) {
            const { source: _source, ...normalizedAvatar } = parsed.data;
            return normalizedAvatar;
          }
        }
        return parsed.data;
      } catch {
        return null;
      }
    } finally {
      database.close();
    }
  }

  async put(avatarInput: LocalAvatar): Promise<void> {
    const avatar = LocalAvatarSchema.parse(avatarInput);
    validateNormalizedAvatarPng(avatar.bytes);
    if ((await sha256(avatar.bytes)) !== avatar.sha256) {
      throw new Error("头像 SHA-256 与规范化 PNG 不一致");
    }
    if (avatar.source) {
      const sourceInfo = validateAvatarInputPng(avatar.source.bytes);
      if (
        sourceInfo.width !== avatar.source.width ||
        sourceInfo.height !== avatar.source.height ||
        (await sha256(avatar.source.bytes)) !== avatar.source.sha256
      ) {
        throw new Error("头像源文件尺寸与元数据不一致");
      }
    }
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PROFILE_STORE, "readwrite");
      transaction.objectStore(PROFILE_STORE).put(avatar, ACTIVE_AVATAR_KEY);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }

  async remove(): Promise<void> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PROFILE_STORE, "readwrite");
      transaction.objectStore(PROFILE_STORE).delete(ACTIVE_AVATAR_KEY);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }
}

class BrowserWordSelectionStore {
  async get(): Promise<WordPackSelection | null> {
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PREFERENCES_STORE, "readonly");
      const value = await requestResult<unknown>(
        transaction
          .objectStore(PREFERENCES_STORE)
          .get(WORD_SELECTION_KEY) as IDBRequest<unknown>
      );
      await transactionDone(transaction);
      const parsed = WordPackSelectionSchema.safeParse(value);
      return parsed.success ? parsed.data : null;
    } finally {
      database.close();
    }
  }

  async put(selectionInput: WordPackSelection): Promise<void> {
    const selection = WordPackSelectionSchema.parse(selectionInput);
    const database = await openDatabase();
    try {
      const transaction = database.transaction(PREFERENCES_STORE, "readwrite");
      transaction.objectStore(PREFERENCES_STORE).put(selection, WORD_SELECTION_KEY);
      await transactionDone(transaction);
    } finally {
      database.close();
    }
  }
}

async function openWordPackFiles(): Promise<
  Array<{ name: string; bytes: Uint8Array }>
> {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json,.drawguess-words.json,application/json";
    input.multiple = true;
    input.addEventListener(
      "change",
      () => {
        void Promise.all(
          [...(input.files ?? [])].map(async (file) => ({
            name: file.name,
            bytes: new Uint8Array(await file.arrayBuffer())
          }))
        ).then(resolve);
      },
      { once: true }
    );
    input.addEventListener("cancel", () => resolve([]), { once: true });
    input.click();
  });
}

function saveWordPackFile(suggestedName: string, bytes: Uint8Array): Promise<boolean> {
  const safeName = `${sanitizeExportFilename(suggestedName)}.drawguess-words.json`;
  const buffer = new ArrayBuffer(bytes.byteLength);
  new Uint8Array(buffer).set(bytes);
  const url = URL.createObjectURL(
    new Blob([buffer], { type: "application/json;charset=utf-8" })
  );
  try {
    const anchor = document.createElement("a");
    anchor.download = safeName;
    anchor.href = url;
    anchor.click();
    return Promise.resolve(true);
  } finally {
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }
}

let browserServices: LocalContentServices | null = null;

export function createBrowserContentServices(): LocalContentServices {
  browserServices ??= {
    wordPacks: new BrowserWordPackStore(),
    avatar: new BrowserAvatarStore(),
    wordSelection: new BrowserWordSelectionStore(),
    wordFiles: {
      open: openWordPackFiles,
      save: saveWordPackFile
    }
  };
  return browserServices;
}
