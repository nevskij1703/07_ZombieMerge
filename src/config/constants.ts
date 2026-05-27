// Дизайн-разрешение (портрет). Phaser Scale.FIT масштабирует под экран устройства.
export const DESIGN_WIDTH = 720;
export const DESIGN_HEIGHT = 1280;

// Палитра-заглушка для примитивов MVP (визуал придёт позже).
export const COLORS = {
  bg: 0x0e0f12,
  city: 0x1a2f1a,
  fence: 0x444a55,
  base: 0x15171c,
  accent: 0x9fe870,
  text: 0xcccccc,
} as const;

// Цвет плитки оружия по тиру (1-based; index 0 — заглушка). Примитивы MVP.
export const TIER_COLORS: number[] = [
  0x333333,
  0x8a8f98, 0xa9b1ba, 0xc98a3a, 0xd9d2c0, 0xb03a3a, 0x3a7bd5,
  0x3ad5a0, 0xd5c43a, 0xd53a9b, 0x7a3ad5, 0xff6a00, 0x00e5ff,
];

export const UI = {
  hudBg: 0x0a0b0e,
  slot: 0x20242c,
  slotStroke: 0x3a414d,
  btn: 0x2e7d32,
  btnDisabled: 0x3a3f47,
  btnText: '#ffffff',
} as const;
