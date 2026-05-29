// Battle сцена удалена — теперь это «mode» внутри одной мировой сцены (Base).
// Камера скроллится между базой (Y=0..1280) и дорогой (Y<0) в одном пространстве.
export const SceneKey = {
  Boot: 'Boot',
  Base: 'Base',
} as const;

export type SceneKey = (typeof SceneKey)[keyof typeof SceneKey];
