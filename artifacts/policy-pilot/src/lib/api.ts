type TokenGetter = () => Promise<string | null> | string | null;

const BASE = import.meta.env.BASE_URL.replace(/\/$/, "");

export const API_BASE = `${BASE}/api`;

let _tokenGetter: TokenGetter | null = null;

export function setApiTokenGetter(getter: TokenGetter | null) {
  _tokenGetter = getter;
}

async function authHeaders(): Promise<Record<string, string>> {
  if (!_tokenGetter) return {};
  const token = await _tokenGetter();
  return token ? { Authorization: `Bearer ${token}` } : {};
}

export async function apiFetch<T>(path: string, options?: RequestInit): Promise<T> {
  const auth = await authHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...auth,
      ...(options?.headers ?? {}),
    },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  if (res.status === 204 || res.headers.get("Content-Length") === "0") {
    return undefined as unknown as T;
  }
  return res.json() as Promise<T>;
}

export async function apiUpload<T>(path: string, formData: FormData): Promise<T> {
  const auth = await authHeaders();
  const res = await fetch(`${API_BASE}${path}`, {
    method: "POST",
    headers: auth,
    body: formData,
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? res.statusText);
  }
  return res.json() as Promise<T>;
}
