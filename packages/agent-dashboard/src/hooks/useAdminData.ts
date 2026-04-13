import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJSON } from "../api/client";

interface UseAdminDataResult<T> {
  data: T | null;
  loading: boolean;
  error: string | null;
}

export function useAdminData<T>(path: string, intervalMs = 5000): UseAdminDataResult<T> {
  const [data, setData] = useState<T | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const mountedRef = useRef(true);

  const load = useCallback(async () => {
    try {
      const result = await fetchJSON<T>(path);
      if (mountedRef.current) {
        setData(result);
        setError(null);
        setLoading(false);
      }
    } catch (err) {
      if (mountedRef.current) {
        setError(err instanceof Error ? err.message : "Unknown error");
        setLoading(false);
      }
    }
  }, [path]);

  useEffect(() => {
    mountedRef.current = true;
    setLoading(true);
    load();
    const id = setInterval(load, intervalMs);
    return () => {
      mountedRef.current = false;
      clearInterval(id);
    };
  }, [load, intervalMs]);

  return { data, loading, error };
}
