import { useCallback, useEffect, useState } from "react";
import { ApiError } from "./api.js";

export interface AsyncState<T> {
  data?: T;
  loading: boolean;
  error?: string;
  refetch: () => void;
}

/** Fetch-on-mount with loading/error/refetch. `deps` re-runs the fetch. */
export function useApi<T>(fn: () => Promise<T>, deps: unknown[] = []): AsyncState<T> {
  const [state, setState] = useState<{ data?: T; loading: boolean; error?: string }>({ loading: true });
  const [nonce, setNonce] = useState(0);
  const refetch = useCallback(() => setNonce((n) => n + 1), []);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ data: s.data, loading: true, error: undefined }));
    fn()
      .then((d) => alive && setState({ data: d, loading: false }))
      .catch((e: unknown) => alive && setState({ loading: false, error: e instanceof Error ? e.message : String(e) }));
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, nonce]);
  return { ...state, refetch };
}

/** Wrap a mutating action with pending state + error surfacing. */
export function useAction<A extends unknown[]>(
  fn: (...args: A) => Promise<unknown>
): { run: (...args: A) => Promise<boolean>; pending: boolean; error?: string } {
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | undefined>();
  const run = useCallback(
    async (...args: A) => {
      setPending(true);
      setError(undefined);
      try {
        await fn(...args);
        return true;
      } catch (e) {
        setError(e instanceof ApiError ? e.message : e instanceof Error ? e.message : String(e));
        return false;
      } finally {
        setPending(false);
      }
    },
    [fn]
  );
  return { run, pending, error };
}
