// Одна мировая сцена на всё (база + бой). Камера скроллит между базой (Y=0..1280)
// и дорогой (Y<0). Battle — это `mode` внутри WorldScene, не отдельная сцена.
export const SceneKey = {
  Boot: 'Boot',
  World: 'World',
} as const;

export type SceneKey = (typeof SceneKey)[keyof typeof SceneKey];
