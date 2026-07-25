import { useEffect, useMemo, useState } from "react";

import {
  BUILTIN_WORD_PACK,
  buildWordPool,
  selectionFromPacks,
  type LocalContentServices,
  type WordPackFile,
  type WordPackSelection,
  type WordPoolUpload
} from "@draw-guess/content";
import type {
  PublicClassicModeState,
  PublicDrawRelayModeState,
  PublicRoomSnapshot
} from "@draw-guess/shared-types";

function defaultSelection(): WordPackSelection {
  return {
    schemaVersion: 1,
    packs: [
      {
        packId: BUILTIN_WORD_PACK.id,
        categoryIds: BUILTIN_WORD_PACK.categories
          .filter((category) => category.enabled)
          .map((category) => category.id)
      }
    ]
  };
}

function selectionMap(
  selection: WordPackSelection,
  packs: readonly WordPackFile[]
): Map<string, Set<string>> {
  const available = new Map(
    packs.map((pack) => [
      pack.id,
      new Set(pack.categories.map((category) => category.id))
    ])
  );
  return new Map(
    selection.packs.flatMap((selectedPack) => {
      const categoryIds = available.get(selectedPack.packId);
      if (!categoryIds) {
        return [];
      }
      const selected = selectedPack.categoryIds.filter((id) => categoryIds.has(id));
      return selected.length ? [[selectedPack.packId, new Set(selected)] as const] : [];
    })
  );
}

function storedSelection(selected: ReadonlyMap<string, ReadonlySet<string>>) {
  return {
    schemaVersion: 1 as const,
    packs: [...selected].map(([packId, categoryIds]) => ({
      packId,
      categoryIds: [...categoryIds]
    }))
  };
}

export function WordPoolPanel({
  snapshot,
  game,
  services,
  upload,
  onManageWords,
  onMessage
}: {
  snapshot: PublicRoomSnapshot;
  game: PublicClassicModeState | PublicDrawRelayModeState;
  services: LocalContentServices;
  upload: (wordPool: WordPoolUpload) => Promise<void>;
  onManageWords: () => void;
  onMessage: (message: string) => void;
}) {
  const isHost = snapshot.hostId === snapshot.selfPlayerId;
  const [packs, setPacks] = useState<WordPackFile[]>([
    structuredClone(BUILTIN_WORD_PACK)
  ]);
  const [selected, setSelected] = useState<Map<string, Set<string>>>(
    selectionMap(defaultSelection(), [BUILTIN_WORD_PACK])
  );
  const [lastSelection, setLastSelection] = useState<WordPackSelection | null>(null);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const summaries = await services.wordPacks.list();
    const local = (
      await Promise.all(summaries.map((summary) => services.wordPacks.get(summary.id)))
    ).filter((pack): pack is WordPackFile => Boolean(pack));
    const nextPacks = [structuredClone(BUILTIN_WORD_PACK), ...local];
    const saved = await services.wordSelection.get();
    setPacks(nextPacks);
    setLastSelection(saved);
    if (saved) {
      const restored = selectionMap(saved, nextPacks);
      if (restored.size > 0) {
        setSelected(restored);
      }
    }
  };

  useEffect(() => {
    void load().catch((error: unknown) =>
      onMessage(error instanceof Error ? error.message : "读取本地词库失败")
    );
  }, [services]);

  const calculation = useMemo(() => {
    try {
      const wordPool = selectionFromPacks(selected, packs);
      return { wordPool, built: buildWordPool(wordPool), error: null };
    } catch (error) {
      return {
        wordPool: null,
        built: null,
        error: error instanceof Error ? error.message : "词池选择无效"
      };
    }
  }, [packs, selected]);

  const toggleCategory = (packId: string, categoryId: string, enabled: boolean) => {
    setSelected((current) => {
      const next = new Map(
        [...current].map(([id, categoryIds]) => [id, new Set(categoryIds)])
      );
      const categories = next.get(packId) ?? new Set<string>();
      if (enabled) {
        categories.add(categoryId);
        next.set(packId, categories);
      } else {
        categories.delete(categoryId);
        if (categories.size === 0) {
          next.delete(packId);
        } else {
          next.set(packId, categories);
        }
      }
      return next;
    });
    setDirty(true);
  };

  const togglePack = (pack: WordPackFile, enabled: boolean) => {
    setSelected((current) => {
      const next = new Map(
        [...current].map(([id, categoryIds]) => [id, new Set(categoryIds)])
      );
      if (enabled) {
        next.set(
          pack.id,
          new Set(
            pack.categories
              .filter((category) => category.enabled)
              .map((category) => category.id)
          )
        );
      } else {
        next.delete(pack.id);
      }
      return next;
    });
    setDirty(true);
  };

  const apply = async () => {
    if (!calculation.wordPool) {
      onMessage(calculation.error ?? "词池选择无效");
      return;
    }
    setBusy(true);
    try {
      await upload(calculation.wordPool);
      const selection = storedSelection(selected);
      await services.wordSelection.put(selection);
      setLastSelection(selection);
      setDirty(false);
      onMessage("本局词池已在服务器大厅中更新");
    } catch (error) {
      onMessage(error instanceof Error ? error.message : "本局词池更新失败");
    } finally {
      setBusy(false);
    }
  };

  if (!isHost) {
    return (
      <section className="panel word-pool-panel" data-ui="word-pool-summary">
        <div className="panel-heading">
          <div>
            <p className="eyebrow">Word pool</p>
            <h2>本局词库</h2>
          </div>
          <span className="step-pill">{game.wordPool.uniqueWordCount} 词</span>
        </div>
        <div className="word-pool-summary">
          {game.wordPool.packs.map((pack) => (
            <article key={`${pack.name}:${pack.selectedCategoryNames.join("|")}`}>
              <strong>{pack.name}</strong>
              <span>{pack.selectedCategoryNames.join("、")}</span>
              <small>{pack.enabledWordCount} 个启用词条</small>
            </article>
          ))}
          <p>完整词条、别名和题目顺序只保留在服务器与当前画手私密消息中。</p>
        </div>
      </section>
    );
  }

  const expectedOptions =
    (game.mode === "classic" ? game.settings.rounds : 1) *
    Math.max(1, snapshot.players.filter((player) => player.captureReady).length) *
    3;
  return (
    <section className="panel word-pool-panel" data-ui="word-pool-settings">
      <div className="panel-heading">
        <div>
          <p className="eyebrow">Word pool · Host only</p>
          <h2>本局词库</h2>
        </div>
        <span className="step-pill">
          {calculation.built?.words.length ?? 0} 个唯一词
        </span>
      </div>
      <div className="word-pool-panel__body">
        <div className="word-pool-list">
          {packs.map((pack) => {
            const selectedCategories = selected.get(pack.id) ?? new Set();
            return (
              <article key={pack.id}>
                <label className="word-pack-toggle">
                  <input
                    checked={
                      selectedCategories.size > 0 &&
                      pack.categories
                        .filter((category) => category.enabled)
                        .every((category) => selectedCategories.has(category.id))
                    }
                    onChange={(event) => togglePack(pack, event.target.checked)}
                    type="checkbox"
                  />
                  <span>
                    <strong>{pack.name}</strong>
                    <small>
                      {pack.id === BUILTIN_WORD_PACK.id ? "内置" : "本地"} ·{" "}
                      {pack.categories.length} 类
                    </small>
                  </span>
                </label>
                <div>
                  {pack.categories.map((category) => (
                    <label key={category.id}>
                      <input
                        checked={selectedCategories.has(category.id)}
                        disabled={!category.enabled}
                        onChange={(event) =>
                          toggleCategory(pack.id, category.id, event.target.checked)
                        }
                        type="checkbox"
                      />
                      {category.name}
                      <small>
                        {category.words.filter((word) => word.enabled).length} 词
                      </small>
                    </label>
                  ))}
                </div>
              </article>
            );
          })}
        </div>

        <div className="word-pool-calculation">
          <span>
            简单 <strong>{calculation.built?.difficulty.easy ?? 0}</strong>
          </span>
          <span>
            普通 <strong>{calculation.built?.difficulty.normal ?? 0}</strong>
          </span>
          <span>
            困难 <strong>{calculation.built?.difficulty.hard ?? 0}</strong>
          </span>
          <span>
            冲突 <strong>{calculation.built?.conflicts.length ?? 0}</strong>
          </span>
        </div>
        {(calculation.built?.words.length ?? 0) < 3 && (
          <p className="inline-error">至少选择 3 个有效唯一词条才能开始游戏。</p>
        )}
        {(calculation.built?.words.length ?? 0) >= 3 &&
          (calculation.built?.words.length ?? 0) < expectedOptions && (
            <p className="inline-warning">
              当前词池可能在一局内耗尽；耗尽后会重新洗牌，适合小词库测试。
            </p>
          )}
        {dirty && (
          <p className="inline-warning">
            本地选择尚未提交；服务器仍使用上方公开摘要中的词池。
          </p>
        )}
        <div className="word-pool-actions">
          <button className="secondary-button" onClick={onManageWords} type="button">
            管理词库包
          </button>
          <button
            className="secondary-button"
            disabled={!lastSelection}
            onClick={() => {
              if (lastSelection) {
                setSelected(selectionMap(lastSelection, packs));
                setDirty(true);
              }
            }}
            type="button"
          >
            恢复上次选择
          </button>
          <button
            className="secondary-button"
            onClick={() => {
              setSelected(selectionMap(defaultSelection(), packs));
              setDirty(true);
            }}
            type="button"
          >
            恢复基础词库
          </button>
          <button
            className="primary-button"
            disabled={busy || !calculation.wordPool}
            onClick={() => void apply()}
            type="button"
          >
            {busy ? "正在验证…" : "应用到本局"}
          </button>
        </div>
      </div>
    </section>
  );
}
