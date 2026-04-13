export async function fetchJSON<T>(path: string, options?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  if (!response.ok) {
    throw new Error(`HTTP ${response.status}: ${response.statusText}`);
  }
  return response.json() as Promise<T>;
}

export interface SSEConnection {
  close(): void;
}

export function connectSSE(path: string, onEvent: (event: MessageEvent) => void): SSEConnection {
  const source = new EventSource(path);
  source.onmessage = onEvent;
  source.onerror = () => {
    source.close();
  };
  return {
    close() {
      source.close();
    },
  };
}
