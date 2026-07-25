import type { LocalContentServices } from "@draw-guess/content";

export const desktopContentServices: LocalContentServices = {
  wordPacks: {
    list: () => window.drawGuessDesktop.content.wordPacks.list(),
    get: (id) => window.drawGuessDesktop.content.wordPacks.get(id),
    put: (pack) => window.drawGuessDesktop.content.wordPacks.put(pack),
    remove: (id) => window.drawGuessDesktop.content.wordPacks.remove(id)
  },
  avatar: {
    getActive: () => window.drawGuessDesktop.content.avatar.get(),
    put: (avatar) => window.drawGuessDesktop.content.avatar.put(avatar),
    remove: () => window.drawGuessDesktop.content.avatar.remove()
  },
  wordSelection: {
    get: () => window.drawGuessDesktop.content.wordSelection.get(),
    put: (selection) => window.drawGuessDesktop.content.wordSelection.put(selection)
  },
  wordFiles: {
    open: () => window.drawGuessDesktop.content.wordFiles.open(),
    save: (suggestedName, bytes) =>
      window.drawGuessDesktop.content.wordFiles.save(suggestedName, bytes)
  }
};
