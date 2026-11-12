/**
 * 《花砖物语》(Azul) 规则常量。
 *
 * 依据官方规则书（Next Move / Asmodee, EN-Azul-Rules）：
 *  - 100 块砖，5 色各 20 块
 *  - 工厂圆盘数：2 人 5 个、3 人 7 个、4 人 9 个，每盘 4 块
 *  - 图案行 5 条，容量 1~5；地板区 7 格，罚分 -1/-1/-2/-2/-2/-3/-3
 *  - 墙面 5×5，每行每列各含五色一次（拉丁方，每行右移一格）
 */

export const COLORS = 5;

/** 颜色代号，仅用于前端取色与日志可读性。 */
export const COLOR_KEYS = ['azure', 'amber', 'crimson', 'obsidian', 'ivory'];

/** 中文名，用于日志与提示。 */
export const COLOR_NAMES = ['蓝', '黄', '红', '黑', '白'];

/** 每色砖块数量。 */
export const TILES_PER_COLOR = 20;

/** 砖块总数（守恒校验用）。 */
export const TOTAL_TILES = COLORS * TILES_PER_COLOR;

/** 每种人数对应的工厂圆盘数。 */
export const FACTORY_COUNT_BY_PLAYERS = Object.freeze({ 2: 5, 3: 7, 4: 9 });

/** 每个工厂圆盘每轮铺的砖数。 */
export const TILES_PER_FACTORY = 4;

/** 图案行容量，索引即行号。 */
export const PATTERN_CAP = Object.freeze([1, 2, 3, 4, 5]);

/** 地板区罚分表（7 格，从左到右）。 */
export const FLOOR_PENALTY = Object.freeze([-1, -1, -2, -2, -2, -3, -3]);

/** 地板区格数。 */
export const FLOOR_SIZE = FLOOR_PENALTY.length;

/**
 * 起始玩家标记在地板区数组里的哨兵值。
 * 颜色号是 0~4，因此 -1 不会与任何砖块混淆。
 */
export const FIRST_TOKEN = -1;

/** 墙是否已放置的哨兵值。 */
export const EMPTY = -1;

/**
 * 墙面颜色布局：WALL_COLOR[row][col] = 颜色号。
 * 每行相对上一行右移一格，使每行每列都恰好包含五种颜色，
 * 且主对角线恒为「蓝」——与官方玩家板一致。
 */
export const WALL_COLOR = Object.freeze(
  Array.from({ length: 5 }, (_, row) =>
    Object.freeze(Array.from({ length: 5 }, (_, col) => (col - row + 5) % 5)),
  ),
);

/** 终局奖励分。 */
export const BONUS = Object.freeze({ row: 2, column: 7, color: 10 });

/** 合法人数。 */
export const PLAYER_COUNTS = Object.freeze([2, 3, 4]);

/**
 * 判断某条图案行在墙面上的「本行颜色集合」是否已包含该色。
 * 图案行不允许放进这种颜色（官方：cannot place a color into a pattern line
 * whose corresponding wall line already holds that color）。
 */
export function wallRowHasColumn(wallRow, color) {
  return wallRow.includes(color);
}
