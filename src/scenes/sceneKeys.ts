export const SceneKey = {
  Boot: 'Boot',
  Base: 'Base',
  Battle: 'Battle',
} as const;

export type SceneKey = (typeof SceneKey)[keyof typeof SceneKey];
