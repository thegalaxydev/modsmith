import type { AppPaths } from './paths';
import type { Store } from './db';
import type { EventBus } from './events';
import type { OperationManager } from './operations';
import type { JavaService } from './java';
import type { CompatibilityCatalog } from './catalog';
import type { HttpClient } from './http';
import type { ModrinthClient } from './modrinth';
import type { CurseForgeClient } from './curseforge';
import type { SecretStore } from './secrets';
import type { BridgeHost } from './bridge';
import type { InstanceManager } from './instances';
import type { LoaderAdapter } from './adapters/types';
import type { LoaderId } from '../shared/types';

export interface Services {
  paths: AppPaths;
  store: Store;
  bus: EventBus;
  ops: OperationManager;
  java: JavaService;
  catalog: CompatibilityCatalog;
  http: HttpClient;
  modrinth: ModrinthClient;
  curseforge: CurseForgeClient;
  secrets: SecretStore;
  bridge: BridgeHost;
  instances: InstanceManager;
  adapters: Record<LoaderId, LoaderAdapter>;
}
