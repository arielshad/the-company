import { useSyncExternalStore } from "react";
import { platform } from "./platform.js";

/** Tiny reactive layer: components subscribe and re-render on mutations. */
const listeners = new Set<() => void>();
let version = 0;
function emit() {
  version++;
  listeners.forEach((l) => l());
}
function subscribe(cb: () => void) {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Subscribe a component to platform changes. Returns the live platform. */
export function usePlatform() {
  useSyncExternalStore(
    subscribe,
    () => version,
    () => version
  );
  return platform;
}

/** Run a mutation then notify subscribers. */
export async function mutate<T>(fn: () => T | Promise<T>): Promise<T> {
  const r = await fn();
  emit();
  return r;
}

/* ---------------- toasts ---------------- */
export interface Toast {
  id: number;
  text: string;
  kind: "ok" | "error";
}
let toasts: Toast[] = [];
const toastListeners = new Set<() => void>();
let tid = 0;
export function pushToast(text: string, kind: "ok" | "error" = "ok") {
  const t = { id: ++tid, text, kind };
  toasts = [...toasts, t];
  toastListeners.forEach((l) => l());
  setTimeout(() => {
    toasts = toasts.filter((x) => x.id !== t.id);
    toastListeners.forEach((l) => l());
  }, 3800);
}
export function useToasts(): Toast[] {
  return useSyncExternalStore(
    (cb) => {
      toastListeners.add(cb);
      return () => toastListeners.delete(cb);
    },
    () => toasts,
    () => toasts
  );
}

/* ---------------- onboarding state (persisted) ---------------- */
const KEY = "companyos.onboarding.v1";
export interface OnboardingState {
  completed: boolean;
  step: number;
  /** Checklist of "tried it" actions, surfaced on the dashboard. */
  done: Record<string, boolean>;
}
function read(): OnboardingState {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return JSON.parse(raw) as OnboardingState;
  } catch {
    /* ignore */
  }
  return { completed: false, step: 0, done: {} };
}
let onboarding = read();
const onbListeners = new Set<() => void>();
function writeOnb() {
  try {
    localStorage.setItem(KEY, JSON.stringify(onboarding));
  } catch {
    /* ignore */
  }
  onbListeners.forEach((l) => l());
}
export function useOnboarding(): OnboardingState {
  return useSyncExternalStore(
    (cb) => {
      onbListeners.add(cb);
      return () => onbListeners.delete(cb);
    },
    () => onboarding,
    () => onboarding
  );
}
export function setOnboardingStep(step: number) {
  onboarding = { ...onboarding, step };
  writeOnb();
}
export function completeOnboarding() {
  onboarding = { ...onboarding, completed: true };
  writeOnb();
}
export function startOnboarding() {
  onboarding = { ...onboarding, completed: false, step: 0 };
  writeOnb();
}
export function markDone(key: string) {
  if (onboarding.done[key]) return;
  onboarding = { ...onboarding, done: { ...onboarding.done, [key]: true } };
  writeOnb();
}
