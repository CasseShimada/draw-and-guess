import { WordPackFileSchema, type WordPackFile } from "./word-pack-schema.js";

function id(group: number, item = 0): string {
  return `${String(group).padStart(8, "0")}-0000-4000-8000-${String(item).padStart(12, "0")}`;
}

const categories: Array<{
  name: string;
  words: Array<string | [string, string[]]>;
}> = [
  {
    name: "动物",
    words: ["熊猫", "长颈鹿", "章鱼", "刺猬", "企鹅"]
  },
  {
    name: "食物",
    words: ["火锅", "冰淇淋", "饺子", "爆米花", "生日蛋糕"]
  },
  {
    name: "物品",
    words: ["机器人", "闹钟", "雨伞", "显微镜", "魔法帽"]
  },
  {
    name: "交通工具",
    words: ["热气球", "消防车", "潜水艇", "自行车", "宇宙飞船"]
  },
  {
    name: "自然与天气",
    words: ["彩虹", "龙卷风", "火山", "雪人", "流星"]
  },
  {
    name: "动作",
    words: ["打喷嚏", "放风筝", "睡懒觉", "跳绳", "刷牙"]
  },
  {
    name: "体育",
    words: ["踢足球", "打篮球"]
  },
  {
    name: "人物与职业",
    words: ["宇航员", "消防员"]
  },
  {
    name: "场所与建筑",
    words: ["图书馆", "摩天大楼"]
  },
  {
    name: "科技",
    words: ["人工智能", ["智能手机", ["手机"]]]
  },
  {
    name: "成语与短语",
    words: ["画蛇添足", "守株待兔"]
  },
  {
    name: "影视、动画与游戏",
    words: ["超级英雄", "电子游戏"]
  }
];

export const BUILTIN_WORD_PACK: WordPackFile = WordPackFileSchema.parse({
  format: "draw-guess-word-pack",
  schemaVersion: 1,
  id: id(1),
  name: "基础词库",
  description: "随画猜现场提供的只读基础词库，可复制后自行编辑。",
  language: "zh-CN",
  author: "Draw Guess Contributors",
  revision: 1,
  categories: categories.map((category, categoryIndex) => ({
    id: id(100 + categoryIndex),
    name: category.name,
    enabled: true,
    words: category.words.map((value, wordIndex) => {
      const [text, aliases] = Array.isArray(value) ? value : [value, undefined];
      return {
        id: id(1_000 + categoryIndex, wordIndex + 1),
        text,
        ...(aliases ? { aliases } : {}),
        difficulty: "normal",
        enabled: true
      };
    })
  })),
  createdAt: "2026-07-25T00:00:00.000Z",
  updatedAt: "2026-07-25T00:00:00.000Z"
});
