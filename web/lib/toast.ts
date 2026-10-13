// A tiny toast store. Not a library on purpose: the usual ones inject an un-nonced <style> tag,
// which the strict CSP (style-src 'self' + nonce) blocks.

export type ToastKind = "success" | "error" | "info";
export type ToastItem = { id: number; kind: ToastKind; message: string };

let items: ToastItem[] = [];
let nextId = 1;
const listeners = new Set<() => void>();

const emit = () => listeners.forEach((l) => l());

export function subscribe(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}
export const getToasts = () => items;

export function dismiss(id: number): void {
  items = items.filter((t) => t.id !== id);
  emit();
}

function push(kind: ToastKind, message: string): number {
  const id = nextId++;
  items = [...items.slice(-3), { id, kind, message }];
  emit();
  return id;
}

export const toast = {
  success: (m: string) => push("success", m),
  error: (m: string) => push("error", m),
  info: (m: string) => push("info", m),
};
