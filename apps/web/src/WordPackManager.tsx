import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";

import {
  BUILTIN_WORD_PACK,
  CONTENT_LIMITS,
  WordEntrySchema,
  WordPackFileSchema,
  copyWordPack,
  createEmptyWordPack,
  normalizeAnswer,
  parseWordPackBytes,
  resolveImportedWordPack,
  serializeWordPack,
  summarizeWordPack,
  type ImportConflictDecision,
  type LocalContentServices,
  type WordCategory,
  type WordEntry,
  type WordPackFile,
  type WordPackSummary
} from "@draw-guess/content";

export interface NormalizedWordConflict {
  answer: string;
  labels: string[];
}

export function findNormalizedWordConflicts(
  pack: WordPackFile
): NormalizedWordConflict[] {
  const answers = new Map<string, { entryIds: Set<string>; labels: Set<string> }>();
  for (const category of pack.categories) {
    for (const word of category.words) {
      for (const answer of [word.text, ...(word.aliases ?? [])]) {
        const normalized = normalizeAnswer(answer);
        const existing = answers.get(normalized) ?? {
          entryIds: new Set<string>(),
          labels: new Set<string>()
        };
        existing.entryIds.add(word.id);
        existing.labels.add(word.text);
        answers.set(normalized, existing);
      }
    }
  }
  return [...answers]
    .filter(([, conflict]) => conflict.entryIds.size > 1)
    .map(([answer, conflict]) => ({
      answer,
      labels: [...conflict.labels]
    }));
}

function updateCategory(
  pack: WordPackFile,
  categoryId: string,
  updater: (category: WordCategory) => WordCategory
): WordPackFile {
  return {
    ...pack,
    categories: pack.categories.map((category) =>
      category.id === categoryId ? updater(category) : category
    )
  };
}

function splitAliases(value: string): string[] | undefined {
  const aliases = value
    .split(/[,，、\n]/u)
    .map((alias) => alias.trim())
    .filter(Boolean);
  return aliases.length ? [...new Set(aliases)] : undefined;
}

export function createBatchWordEntries(
  input: string,
  existingWords: readonly WordEntry[],
  createId: () => string = () => crypto.randomUUID()
): WordEntry[] {
  const existing = new Set(
    existingWords.flatMap((word) =>
      [word.text, ...(word.aliases ?? [])].map(normalizeAnswer)
    )
  );
  const additions: WordEntry[] = [];
  for (const [index, line] of input.split(/\r?\n/u).entries()) {
    const text = line.trim();
    const normalized = normalizeAnswer(text);
    if (!normalized || existing.has(normalized)) {
      continue;
    }
    const parsed = WordEntrySchema.safeParse({
      id: createId(),
      text,
      difficulty: "normal",
      enabled: true
    });
    if (!parsed.success) {
      throw new Error(
        `第 ${String(index + 1)} 行不是有效词条：${parsed.error.issues[0]?.message ?? "格式错误"}`
      );
    }
    existing.add(normalized);
    additions.push(parsed.data);
  }
  if (existingWords.length + additions.length > CONTENT_LIMITS.wordsPerPack) {
    throw new Error("批量添加后超过每包 10,000 个词条的限制");
  }
  return additions;
}

export function WordPackManager({
  services,
  onClose
}: {
  services: LocalContentServices;
  onClose: () => void;
}) {
  const [summaries, setSummaries] = useState<WordPackSummary[]>([]);
  const [selectedId, setSelectedId] = useState(BUILTIN_WORD_PACK.id);
  const [draft, setDraft] = useState<WordPackFile>(structuredClone(BUILTIN_WORD_PACK));
  const [selectedCategoryId, setSelectedCategoryId] = useState(
    BUILTIN_WORD_PACK.categories[0]?.id ?? ""
  );
  const [dirty, setDirty] = useState(false);
  const [isNew, setIsNew] = useState(false);
  const [search, setSearch] = useState("");
  const [difficulty, setDifficulty] = useState<"all" | "easy" | "normal" | "hard">(
    "all"
  );
  const [enabledFilter, setEnabledFilter] = useState<"all" | "enabled" | "disabled">(
    "all"
  );
  const [batchText, setBatchText] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [importConflict, setImportConflict] = useState<{
    pack: WordPackFile;
    builtIn: boolean;
  } | null>(null);
  const importResolver = useRef<((decision: ImportConflictDecision) => void) | null>(
    null
  );

  const reload = async () => {
    const local = await services.wordPacks.list();
    setSummaries([
      summarizeWordPack(BUILTIN_WORD_PACK, true),
      ...local.filter((summary) => summary.id !== BUILTIN_WORD_PACK.id)
    ]);
  };

  useEffect(() => {
    void reload().catch((error: unknown) =>
      setMessage(error instanceof Error ? error.message : "读取词库失败")
    );
  }, [services]);

  useEffect(() => {
    const warn = (event: BeforeUnloadEvent) => {
      if (dirty) {
        event.preventDefault();
      }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [dirty]);

  const setEdited = (next: WordPackFile) => {
    setDraft(next);
    setDirty(true);
  };

  const selectPack = async (id: string) => {
    if (dirty && !window.confirm("当前词库有未保存修改。确定放弃修改并切换吗？")) {
      return;
    }
    const pack =
      id === BUILTIN_WORD_PACK.id
        ? structuredClone(BUILTIN_WORD_PACK)
        : await services.wordPacks.get(id);
    if (!pack) {
      setMessage("这个词库已不存在");
      await reload();
      return;
    }
    setSelectedId(id);
    setDraft(pack);
    setSelectedCategoryId(pack.categories[0]?.id ?? "");
    setDirty(false);
    setIsNew(false);
    setMessage(null);
  };

  const createPack = () => {
    if (dirty && !window.confirm("放弃当前未保存修改并新建词库吗？")) {
      return;
    }
    const pack = createEmptyWordPack();
    setSelectedId(pack.id);
    setDraft(pack);
    setSelectedCategoryId("");
    setDirty(true);
    setIsNew(true);
    setMessage(null);
  };

  const copyCurrent = () => {
    const pack = copyWordPack(draft);
    setSelectedId(pack.id);
    setDraft(pack);
    setSelectedCategoryId(pack.categories[0]?.id ?? "");
    setDirty(true);
    setIsNew(true);
    setMessage("副本尚未保存");
  };

  const save = async () => {
    try {
      const now = new Date().toISOString();
      const candidate = WordPackFileSchema.parse({
        ...draft,
        revision: isNew ? 1 : draft.revision + 1,
        updatedAt: now
      });
      serializeWordPack(candidate);
      await services.wordPacks.put(candidate);
      setDraft(candidate);
      setDirty(false);
      setIsNew(false);
      setSelectedId(candidate.id);
      setMessage("词库已保存到当前客户端");
      await reload();
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "词库保存失败");
    }
  };

  const remove = async () => {
    if (selectedId === BUILTIN_WORD_PACK.id) {
      setMessage("内置基础词库不能删除，可以先复制后编辑");
      return;
    }
    if (!window.confirm(`确定删除“${draft.name}”？这个操作无法撤销。`)) {
      return;
    }
    await services.wordPacks.remove(selectedId);
    await reload();
    setSelectedId(BUILTIN_WORD_PACK.id);
    setDraft(structuredClone(BUILTIN_WORD_PACK));
    setSelectedCategoryId(BUILTIN_WORD_PACK.categories[0]?.id ?? "");
    setDirty(false);
    setIsNew(false);
    setMessage("词库已删除");
  };

  const exportPack = async () => {
    try {
      const validated = WordPackFileSchema.parse(draft);
      const bytes = new TextEncoder().encode(serializeWordPack(validated));
      const saved = await services.wordFiles.save(validated.name, bytes);
      setMessage(saved ? "词库包已导出" : "已取消导出");
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导出失败");
    }
  };

  const askConflict = (
    pack: WordPackFile,
    builtIn: boolean
  ): Promise<ImportConflictDecision> =>
    new Promise((resolve) => {
      importResolver.current = resolve;
      setImportConflict({ pack, builtIn });
    });

  const resolveConflict = (decision: ImportConflictDecision) => {
    importResolver.current?.(decision);
    importResolver.current = null;
    setImportConflict(null);
  };

  const importPacks = async () => {
    try {
      const files = await services.wordFiles.open();
      if (files.length === 0) {
        return;
      }
      const existing = new Set(summaries.map((summary) => summary.id));
      let importedCount = 0;
      for (const file of files) {
        const pack = parseWordPackBytes(file.bytes);
        let decision: ImportConflictDecision = "replace";
        if (existing.has(pack.id)) {
          decision = await askConflict(pack, pack.id === BUILTIN_WORD_PACK.id);
        }
        const resolved = resolveImportedWordPack(pack, existing, decision);
        if (!resolved) {
          continue;
        }
        if (resolved.id === BUILTIN_WORD_PACK.id) {
          throw new Error("内置基础词库不能被导入文件替换，请选择保留两份");
        }
        await services.wordPacks.put(resolved);
        existing.add(resolved.id);
        importedCount += 1;
      }
      await reload();
      setMessage(`已导入 ${String(importedCount)} 个词库包`);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "导入失败");
    }
  };

  const readOnly = selectedId === BUILTIN_WORD_PACK.id && !isNew;
  const selectedCategory = draft.categories.find(
    (category) => category.id === selectedCategoryId
  );
  const conflicts = useMemo(() => findNormalizedWordConflicts(draft), [draft]);
  const filteredWords = useMemo(() => {
    if (!selectedCategory) {
      return [];
    }
    const query = normalizeAnswer(search);
    return selectedCategory.words.filter((word) => {
      const matchesSearch =
        !query ||
        [word.text, ...(word.aliases ?? [])].some((answer) =>
          normalizeAnswer(answer).includes(query)
        );
      const matchesDifficulty =
        difficulty === "all" || (word.difficulty ?? "normal") === difficulty;
      const matchesEnabled =
        enabledFilter === "all" ||
        (enabledFilter === "enabled" ? word.enabled : !word.enabled);
      return matchesSearch && matchesDifficulty && matchesEnabled;
    });
  }, [difficulty, enabledFilter, search, selectedCategory]);
  const stats = summarizeWordPack(draft, readOnly);

  const addCategory = () => {
    const category: WordCategory = {
      id: crypto.randomUUID(),
      name: `新分类 ${String(draft.categories.length + 1)}`,
      enabled: true,
      words: []
    };
    setEdited({ ...draft, categories: [...draft.categories, category] });
    setSelectedCategoryId(category.id);
  };

  const moveCategory = (direction: -1 | 1) => {
    const index = draft.categories.findIndex(
      (category) => category.id === selectedCategoryId
    );
    const target = index + direction;
    if (index < 0 || target < 0 || target >= draft.categories.length) {
      return;
    }
    const categories = [...draft.categories];
    [categories[index], categories[target]] = [categories[target]!, categories[index]!];
    setEdited({ ...draft, categories });
  };

  const addWord = () => {
    if (!selectedCategory) {
      setMessage("请先新建或选择一个分类");
      return;
    }
    const word: WordEntry = {
      id: crypto.randomUUID(),
      text: "新词",
      difficulty: "normal",
      enabled: true
    };
    setEdited(
      updateCategory(draft, selectedCategory.id, (category) => ({
        ...category,
        words: [...category.words, word]
      }))
    );
  };

  const batchAdd = (event: FormEvent) => {
    event.preventDefault();
    if (!selectedCategory) {
      return;
    }
    let additions: WordEntry[];
    try {
      additions = createBatchWordEntries(batchText, selectedCategory.words);
    } catch (batchError) {
      setMessage(batchError instanceof Error ? batchError.message : "批量词条格式无效");
      return;
    }
    setEdited(
      updateCategory(draft, selectedCategory.id, (category) => ({
        ...category,
        words: [...category.words, ...additions]
      }))
    );
    setBatchText("");
    setMessage(`已添加 ${String(additions.length)} 个不重复词条`);
  };

  const close = () => {
    if (dirty && !window.confirm("还有未保存修改。确定离开词库页面吗？")) {
      return;
    }
    onClose();
  };

  return (
    <main className="word-manager" data-ui="word-pack-manager">
      <header className="word-manager__topbar">
        <div>
          <p className="eyebrow">Local content</p>
          <h1>词库包管理</h1>
          <p>长期保存在当前客户端；只有房主选择的本局词池会临时上传。</p>
        </div>
        <div>
          <button className="secondary-button" onClick={close} type="button">
            返回游戏
          </button>
          <button className="primary-button" onClick={() => void save()} type="button">
            {dirty ? "保存修改" : "已保存"}
          </button>
        </div>
      </header>

      <div className="word-manager__layout">
        <aside className="word-pack-sidebar">
          <div className="word-pack-sidebar__actions">
            <button onClick={createPack} type="button">
              新建
            </button>
            <button onClick={copyCurrent} type="button">
              复制
            </button>
            <button onClick={() => void importPacks()} type="button">
              导入
            </button>
          </div>
          <div className="word-pack-list">
            {summaries.map((summary) => (
              <button
                className={selectedId === summary.id ? "active" : ""}
                key={summary.id}
                onClick={() => void selectPack(summary.id)}
                type="button"
              >
                <span>
                  <strong>{summary.name}</strong>
                  {summary.builtIn && <em>内置 · 只读</em>}
                </span>
                <small>
                  {summary.enabledWordCount}/{summary.wordCount} 词 ·{" "}
                  {summary.categoryCount} 类
                </small>
              </button>
            ))}
            {isNew && !summaries.some((summary) => summary.id === selectedId) && (
              <button className="active" type="button">
                <span>
                  <strong>{draft.name}</strong>
                  <em>未保存</em>
                </span>
              </button>
            )}
          </div>
        </aside>

        <section className="word-pack-editor">
          <div className="word-pack-editor__meta">
            <div className="editor-title">
              <div>
                <p className="eyebrow">
                  {readOnly ? "Built-in package" : "Editable package"}
                </p>
                <h2>{draft.name}</h2>
              </div>
              <div>
                <button onClick={() => void exportPack()} type="button">
                  导出单包
                </button>
                {!readOnly && (
                  <button
                    className="danger-link"
                    onClick={() => void remove()}
                    type="button"
                  >
                    删除
                  </button>
                )}
              </div>
            </div>
            <div className="pack-fields">
              <label>
                包名
                <input
                  disabled={readOnly}
                  maxLength={80}
                  onChange={(event) =>
                    setEdited({ ...draft, name: event.target.value })
                  }
                  value={draft.name}
                />
              </label>
              <label>
                语言
                <input
                  disabled={readOnly}
                  maxLength={35}
                  onChange={(event) =>
                    setEdited({ ...draft, language: event.target.value })
                  }
                  value={draft.language}
                />
              </label>
              <label>
                作者
                <input
                  disabled={readOnly}
                  maxLength={80}
                  onChange={(event) =>
                    setEdited({
                      ...draft,
                      author: event.target.value || undefined
                    })
                  }
                  value={draft.author ?? ""}
                />
              </label>
              <label className="wide">
                描述
                <textarea
                  disabled={readOnly}
                  maxLength={500}
                  onChange={(event) =>
                    setEdited({
                      ...draft,
                      description: event.target.value || undefined
                    })
                  }
                  value={draft.description ?? ""}
                />
              </label>
            </div>
            <div className="pack-stats">
              <span>
                <strong>{stats.wordCount}</strong> 总词条
              </span>
              <span>
                <strong>{stats.enabledWordCount}</strong> 已启用
              </span>
              <span>
                <strong>{stats.categoryCount}</strong> 分类
              </span>
              <span className={conflicts.length ? "conflict" : ""}>
                <strong>{conflicts.length}</strong> 规范化冲突
              </span>
            </div>
          </div>

          <div className="category-editor">
            <aside>
              <header>
                <strong>分类</strong>
                {!readOnly && (
                  <button onClick={addCategory} type="button">
                    + 新建
                  </button>
                )}
              </header>
              {draft.categories.map((category) => (
                <button
                  className={selectedCategoryId === category.id ? "active" : ""}
                  key={category.id}
                  onClick={() => setSelectedCategoryId(category.id)}
                  type="button"
                >
                  <span>{category.name}</span>
                  <small>
                    {category.words.filter((word) => word.enabled).length}/
                    {category.words.length}
                  </small>
                </button>
              ))}
            </aside>

            <section>
              {selectedCategory ? (
                <>
                  <div className="category-toolbar">
                    <input
                      aria-label="分类名称"
                      disabled={readOnly}
                      maxLength={40}
                      onChange={(event) =>
                        setEdited(
                          updateCategory(draft, selectedCategory.id, (category) => ({
                            ...category,
                            name: event.target.value
                          }))
                        )
                      }
                      value={selectedCategory.name}
                    />
                    <label>
                      <input
                        checked={selectedCategory.enabled}
                        disabled={readOnly}
                        onChange={(event) =>
                          setEdited(
                            updateCategory(draft, selectedCategory.id, (category) => ({
                              ...category,
                              enabled: event.target.checked
                            }))
                          )
                        }
                        type="checkbox"
                      />
                      启用分类
                    </label>
                    {!readOnly && (
                      <>
                        <button onClick={() => moveCategory(-1)} type="button">
                          上移
                        </button>
                        <button onClick={() => moveCategory(1)} type="button">
                          下移
                        </button>
                        <button
                          className="danger-link"
                          onClick={() => {
                            if (!window.confirm("删除这个分类及其中全部词条？")) {
                              return;
                            }
                            setEdited({
                              ...draft,
                              categories: draft.categories.filter(
                                (category) => category.id !== selectedCategory.id
                              )
                            });
                            setSelectedCategoryId(
                              draft.categories.find(
                                (category) => category.id !== selectedCategory.id
                              )?.id ?? ""
                            );
                          }}
                          type="button"
                        >
                          删除分类
                        </button>
                      </>
                    )}
                  </div>

                  <div className="word-filters">
                    <input
                      onChange={(event) => setSearch(event.target.value)}
                      placeholder="搜索主词或别名"
                      value={search}
                    />
                    <select
                      aria-label="难度筛选"
                      onChange={(event) =>
                        setDifficulty(event.target.value as typeof difficulty)
                      }
                      value={difficulty}
                    >
                      <option value="all">全部难度</option>
                      <option value="easy">简单</option>
                      <option value="normal">普通</option>
                      <option value="hard">困难</option>
                    </select>
                    <select
                      aria-label="启用状态筛选"
                      onChange={(event) =>
                        setEnabledFilter(event.target.value as typeof enabledFilter)
                      }
                      value={enabledFilter}
                    >
                      <option value="all">全部状态</option>
                      <option value="enabled">已启用</option>
                      <option value="disabled">已禁用</option>
                    </select>
                    {!readOnly && (
                      <button onClick={addWord} type="button">
                        + 新词
                      </button>
                    )}
                  </div>

                  <div className="word-table">
                    <div className="word-table__heading">
                      <span>启用</span>
                      <span>主词</span>
                      <span>别名（逗号分隔）</span>
                      <span>难度</span>
                      <span />
                    </div>
                    {filteredWords.map((word) => (
                      <div className="word-table__row" key={word.id}>
                        <input
                          aria-label={`启用 ${word.text}`}
                          checked={word.enabled}
                          disabled={readOnly}
                          onChange={(event) =>
                            setEdited(
                              updateCategory(
                                draft,
                                selectedCategory.id,
                                (category) => ({
                                  ...category,
                                  words: category.words.map((candidate) =>
                                    candidate.id === word.id
                                      ? {
                                          ...candidate,
                                          enabled: event.target.checked
                                        }
                                      : candidate
                                  )
                                })
                              )
                            )
                          }
                          type="checkbox"
                        />
                        <input
                          aria-label="主词"
                          disabled={readOnly}
                          maxLength={40}
                          onChange={(event) =>
                            setEdited(
                              updateCategory(
                                draft,
                                selectedCategory.id,
                                (category) => ({
                                  ...category,
                                  words: category.words.map((candidate) =>
                                    candidate.id === word.id
                                      ? {
                                          ...candidate,
                                          text: event.target.value
                                        }
                                      : candidate
                                  )
                                })
                              )
                            )
                          }
                          value={word.text}
                        />
                        <input
                          aria-label={`${word.text} 的别名`}
                          disabled={readOnly}
                          onChange={(event) =>
                            setEdited(
                              updateCategory(
                                draft,
                                selectedCategory.id,
                                (category) => ({
                                  ...category,
                                  words: category.words.map((candidate) =>
                                    candidate.id === word.id
                                      ? {
                                          ...candidate,
                                          aliases: splitAliases(event.target.value)
                                        }
                                      : candidate
                                  )
                                })
                              )
                            )
                          }
                          value={(word.aliases ?? []).join("，")}
                        />
                        <select
                          aria-label={`${word.text} 的难度`}
                          disabled={readOnly}
                          onChange={(event) =>
                            setEdited(
                              updateCategory(
                                draft,
                                selectedCategory.id,
                                (category) => ({
                                  ...category,
                                  words: category.words.map((candidate) =>
                                    candidate.id === word.id
                                      ? {
                                          ...candidate,
                                          difficulty: event.target
                                            .value as WordEntry["difficulty"]
                                        }
                                      : candidate
                                  )
                                })
                              )
                            )
                          }
                          value={word.difficulty ?? "normal"}
                        >
                          <option value="easy">简单</option>
                          <option value="normal">普通</option>
                          <option value="hard">困难</option>
                        </select>
                        {!readOnly && (
                          <button
                            aria-label={`删除 ${word.text}`}
                            onClick={() =>
                              setEdited(
                                updateCategory(
                                  draft,
                                  selectedCategory.id,
                                  (category) => ({
                                    ...category,
                                    words: category.words.filter(
                                      (candidate) => candidate.id !== word.id
                                    )
                                  })
                                )
                              )
                            }
                            type="button"
                          >
                            ×
                          </button>
                        )}
                      </div>
                    ))}
                  </div>

                  {!readOnly && (
                    <form className="batch-words" onSubmit={batchAdd}>
                      <label>
                        批量粘贴（一行一个主词）
                        <textarea
                          onChange={(event) => setBatchText(event.target.value)}
                          placeholder={"猫\n狗\n热气球"}
                          value={batchText}
                        />
                      </label>
                      <button className="secondary-button" type="submit">
                        去重后添加
                      </button>
                    </form>
                  )}

                  {conflicts.length > 0 && (
                    <aside className="word-conflicts">
                      <strong>规范化答案冲突</strong>
                      {conflicts.map((conflict) => (
                        <p key={`${conflict.answer}:${conflict.labels.join("|")}`}>
                          “{conflict.answer}” 同时对应：{conflict.labels.join("、")}
                        </p>
                      ))}
                    </aside>
                  )}
                </>
              ) : (
                <div className="empty-inline">
                  <p>这个词库还没有分类。新建分类后即可添加词条。</p>
                </div>
              )}
            </section>
          </div>
        </section>
      </div>

      {message && (
        <button className="toast" onClick={() => setMessage(null)} type="button">
          {message}
        </button>
      )}

      {importConflict && (
        <div className="import-conflict" role="dialog" aria-modal="true">
          <section>
            <p className="eyebrow">Import ID conflict</p>
            <h2>同 ID 词库已经存在</h2>
            <p>
              “{importConflict.pack.name}”与当前客户端中的词库 ID 相同。
              {importConflict.builtIn && " 内置词库不能被替换。"}
            </p>
            <div>
              <button
                className="secondary-button"
                onClick={() => resolveConflict("cancel")}
                type="button"
              >
                取消此包
              </button>
              <button
                className="secondary-button"
                onClick={() => resolveConflict("keep-both")}
                type="button"
              >
                保留两份并生成新 ID
              </button>
              <button
                className="primary-button"
                disabled={importConflict.builtIn}
                onClick={() => resolveConflict("replace")}
                type="button"
              >
                替换本地同 ID 包
              </button>
            </div>
          </section>
        </div>
      )}
    </main>
  );
}
