import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import yaml from "js-yaml";
import { HERMES_HOME } from "./installer";
import { profileHome, safeWriteFile } from "./utils";

// ── Connection Config (local / remote / ssh) ─────────────

export interface SshConnectionConfig {
  host: string;
  port: number;
  username: string;
  keyPath: string;
  remotePort: number;
  localPort: number;
}

export interface ConnectionConfig {
  mode: "local" | "remote" | "ssh";
  remoteUrl: string;
  apiKey: string;
  ssh: SshConnectionConfig;
}

// Lazy getter — avoids circular dependency with installer.ts
// (HERMES_HOME may not be assigned yet when this module first loads)
function desktopConfigFile(): string {
  return join(HERMES_HOME, "desktop.json");
}

function readDesktopConfig(): Record<string, unknown> {
  try {
    const f = desktopConfigFile();
    if (!existsSync(f)) return {};
    return JSON.parse(readFileSync(f, "utf-8"));
  } catch {
    return {};
  }
}

function writeDesktopConfig(data: Record<string, unknown>): void {
  if (!existsSync(HERMES_HOME)) {
    mkdirSync(HERMES_HOME, { recursive: true });
  }
  writeFileSync(desktopConfigFile(), JSON.stringify(data, null, 2), "utf-8");
}

export function getConnectionConfig(): ConnectionConfig {
  const data = readDesktopConfig();
  const ssh = (data.sshConfig as Partial<SshConnectionConfig>) ?? {};
  return {
    mode: (data.connectionMode as "local" | "remote" | "ssh") || "local",
    remoteUrl: (data.remoteUrl as string) || "",
    apiKey: (data.remoteApiKey as string) || "",
    ssh: {
      host: (ssh.host as string) || "",
      port: (ssh.port as number) || 22,
      username: (ssh.username as string) || "",
      keyPath: (ssh.keyPath as string) || "",
      remotePort: (ssh.remotePort as number) || 8642,
      localPort: (ssh.localPort as number) || 18642,
    },
  };
}

export function setConnectionConfig(config: ConnectionConfig): void {
  const data = readDesktopConfig();
  data.connectionMode = config.mode;
  data.remoteUrl = config.remoteUrl;
  data.remoteApiKey = config.apiKey;
  if (config.mode === "ssh") {
    data.sshConfig = config.ssh;
  }
  writeDesktopConfig(data);
}

// ── In-memory cache with TTL ─────────────────────────────
const CACHE_TTL = 5000; // 5 seconds
const _cache = new Map<string, { data: unknown; ts: number }>();

function getCached<T>(key: string): T | undefined {
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (Date.now() - entry.ts > CACHE_TTL) {
    _cache.delete(key);
    return undefined;
  }
  return entry.data as T;
}

function setCache(key: string, data: unknown): void {
  _cache.set(key, { data, ts: Date.now() });
}

function invalidateCache(prefix: string): void {
  const keysToDelete: string[] = [];
  _cache.forEach((_, key) => {
    if (key.startsWith(prefix)) keysToDelete.push(key);
  });
  keysToDelete.forEach((key) => _cache.delete(key));
}

function profilePaths(profile?: string): {
  envFile: string;
  configFile: string;
  home: string;
} {
  const home = profileHome(profile);
  return {
    home,
    envFile: join(home, ".env"),
    configFile: join(home, "config.yaml"),
  };
}

// ── .env file helpers (line-based, regex is fine here) ───

export function readEnv(profile?: string): Record<string, string> {
  const cacheKey = `env:${profile || "default"}`;
  const cached = getCached<Record<string, string>>(cacheKey);
  if (cached) return cached;

  const { envFile } = profilePaths(profile);
  if (!existsSync(envFile)) return {};

  const content = readFileSync(envFile, "utf-8");
  const result: Record<string, string> = {};

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (trimmed.startsWith("#") || !trimmed.includes("=")) continue;

    const eqIndex = trimmed.indexOf("=");
    const key = trimmed.substring(0, eqIndex).trim();
    let value = trimmed.substring(eqIndex + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (value) result[key] = value;
  }

  setCache(cacheKey, result);
  return result;
}

export function setEnvValue(
  key: string,
  value: string,
  profile?: string,
): void {
  const { envFile } = profilePaths(profile);
  invalidateCache(`env:${profile || "default"}`);

  if (!existsSync(envFile)) {
    safeWriteFile(envFile, `${key}=${value}\n`);
    return;
  }

  const content = readFileSync(envFile, "utf-8");
  const lines = content.split("\n");
  let found = false;
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();
    if (trimmed.match(new RegExp(`^#?\\s*${escapedKey}\\s*=`))) {
      lines[i] = `${key}=${value}`;
      found = true;
      break;
    }
  }

  if (!found) {
    lines.push(`${key}=${value}`);
  }

  safeWriteFile(envFile, lines.join("\n"));
}

// ── YAML config helpers (js-yaml based) ──────────────────
//
// Reads and writes ~/.hermes/config.yaml using proper YAML parsing.
// Falls back gracefully if the file is malformed — returns empty/null
// values rather than crashing.

function readYamlConfig(
  profile?: string,
): Record<string, unknown> | null {
  const { configFile } = profilePaths(profile);
  if (!existsSync(configFile)) return null;
  try {
    const content = readFileSync(configFile, "utf-8");
    return yaml.load(content) as Record<string, unknown> | null;
  } catch {
    return null;
  }
}

function writeYamlConfig(
  data: Record<string, unknown>,
  profile?: string,
): void {
  const { configFile } = profilePaths(profile);
  const content = yaml.dump(data, {
    lineWidth: -1, // don't wrap long lines
    quotingType: '"', // prefer double quotes
    forceQuotes: false,
    skipInvalid: true,
  });
  safeWriteFile(configFile, content);
}

export function getConfigValue(key: string, profile?: string): string | null {
  const data = readYamlConfig(profile);
  if (!data) return null;
  const value = data[key];
  if (value === undefined || value === null) return null;
  return String(value);
}

export function setConfigValue(
  key: string,
  value: string,
  profile?: string,
): void {
  const data = readYamlConfig(profile);
  if (!data) return;
  data[key] = value;
  invalidateCache(`mc:${profile || "default"}`);
  writeYamlConfig(data, profile);
}

export function getModelConfig(profile?: string): {
  provider: string;
  model: string;
  baseUrl: string;
} {
  const cacheKey = `mc:${profile || "default"}`;
  const cached = getCached<{ provider: string; model: string; baseUrl: string }>(cacheKey);
  if (cached) return cached;

  const defaults = { provider: "auto", model: "", baseUrl: "" };
  const data = readYamlConfig(profile);
  if (!data) return defaults;

  const modelBlock = data.model as Record<string, unknown> | undefined;
  const result = {
    provider: String(modelBlock?.provider ?? defaults.provider),
    model: String(modelBlock?.default ?? defaults.model),
    baseUrl: String(modelBlock?.base_url ?? defaults.baseUrl),
  };

  setCache(cacheKey, result);
  return result;
}

export function setModelConfig(
  provider: string,
  model: string,
  baseUrl: string,
  profile?: string,
): void {
  invalidateCache(`mc:${profile || "default"}`);
  const data = readYamlConfig(profile);
  if (!data) return;

  // Set model block
  if (!data.model || typeof data.model !== "object") {
    data.model = {};
  }
  const modelBlock = data.model as Record<string, unknown>;
  modelBlock.provider = provider;
  modelBlock.default = model;
  modelBlock.base_url = baseUrl;

  // Disable smart_model_routing if it exists
  if (data.smart_model_routing && typeof data.smart_model_routing === "object") {
    (data.smart_model_routing as Record<string, unknown>).enabled = false;
  }

  // Enable streaming if the key exists
  if ("streaming" in data) {
    data.streaming = true;
  }

  writeYamlConfig(data, profile);
}

export function getHermesHome(profile?: string): string {
  return profilePaths(profile).home;
}

// ── Platform enabled/disabled in config.yaml ────────────

const SUPPORTED_PLATFORMS = ["telegram", "discord", "slack", "whatsapp", "signal"];

export function getPlatformEnabled(profile?: string): Record<string, boolean> {
  const data = readYamlConfig(profile);
  if (!data) return {};

  const platforms = data.platforms as Record<string, unknown> | undefined;
  if (!platforms || typeof platforms !== "object") return {};

  const result: Record<string, boolean> = {};
  for (const platform of SUPPORTED_PLATFORMS) {
    const entry = platforms[platform];
    if (entry && typeof entry === "object") {
      const enabled = (entry as Record<string, unknown>).enabled;
      result[platform] = enabled === true;
    } else {
      result[platform] = false;
    }
  }

  return result;
}

export function setPlatformEnabled(
  platform: string,
  enabled: boolean,
  profile?: string,
): void {
  if (!SUPPORTED_PLATFORMS.includes(platform)) return;

  const data = readYamlConfig(profile);
  if (!data) return;

  if (!data.platforms || typeof data.platforms !== "object") {
    data.platforms = {};
  }
  const platforms = data.platforms as Record<string, unknown>;

  if (!platforms[platform] || typeof platforms[platform] !== "object") {
    platforms[platform] = {};
  }
  (platforms[platform] as Record<string, unknown>).enabled = enabled;

  writeYamlConfig(data, profile);
}

// ── Credential Pool (auth.json) ──────────────────────────

function authFilePath(): string {
  return join(HERMES_HOME, "auth.json");
}

interface CredentialEntry {
  key: string;
  label: string;
}

function readAuthStore(): Record<string, unknown> {
  try {
    const p = authFilePath();
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch {
    return {};
  }
}

function writeAuthStore(store: Record<string, unknown>): void {
  safeWriteFile(authFilePath(), JSON.stringify(store, null, 2));
}

export function getCredentialPool(): Record<string, CredentialEntry[]> {
  const store = readAuthStore();
  const pool = store.credential_pool;
  if (!pool || typeof pool !== "object") return {};
  return pool as Record<string, CredentialEntry[]>;
}

export function setCredentialPool(
  provider: string,
  entries: CredentialEntry[],
): void {
  const store = readAuthStore();
  if (!store.credential_pool || typeof store.credential_pool !== "object") {
    store.credential_pool = {};
  }
  (store.credential_pool as Record<string, CredentialEntry[]>)[provider] =
    entries;
  writeAuthStore(store);
}
