export const PRODUCT = {
  name: 'Modsmith',
  id: 'modsmith',
  version: '0.1.15',
  repository: 'thegalaxydev/modsmith',
  manifestFile: 'modsmith.json',
  stateDir: '.modsmith',
  envPrefix: 'MODSMITH',
  bridgeModId: 'modsmith_bridge',
  bridgeProtocolVersion: 1,
  serviceProtocolVersion: 1
} as const;

export const ENV = {
  dataDir: `${PRODUCT.envPrefix}_DATA_DIR`,
  cacheDir: `${PRODUCT.envPrefix}_CACHE_DIR`,
  bridgeUrl: `${PRODUCT.envPrefix}_BRIDGE_URL`,
  bridgeToken: `${PRODUCT.envPrefix}_BRIDGE_TOKEN`,
  bridgeSession: `${PRODUCT.envPrefix}_BRIDGE_SESSION`,
  demo: `${PRODUCT.envPrefix}_DEMO`
} as const;
