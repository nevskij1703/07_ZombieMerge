// Общий shim для CLI-прогона модулей, рассчитанных на браузер (localStorage).
// Используется в balance-quick / balance-deep до import'ов из src/core/*.
export {};

if (typeof globalThis.localStorage === 'undefined') {
  const store: Record<string, string> = {};
  // @ts-expect-error глобальный shim для node
  globalThis.localStorage = {
    getItem: (k: string) => (k in store ? store[k] : null),
    setItem: (k: string, v: string) => {
      store[k] = String(v);
    },
    removeItem: (k: string) => {
      delete store[k];
    },
    clear: () => {
      for (const k of Object.keys(store)) delete store[k];
    },
    key: (i: number) => Object.keys(store)[i] ?? null,
    get length(): number {
      return Object.keys(store).length;
    },
  };
}
