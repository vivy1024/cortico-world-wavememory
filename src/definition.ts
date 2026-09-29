import type { WorldDefinition } from 'cortico/world.ts';
import { WAVEMEMORY_DEFAULTS, type WaveMemoryConfigSection } from './config.ts';
import { WaveMemoryWorld } from './world.ts';

export const WAVEMEMORY: WorldDefinition<WaveMemoryConfigSection> = {
  id: 'wavememory',
  label: 'WaveMemory',
  defaults: () => ({ ...WAVEMEMORY_DEFAULTS() }),
  create: (ctx) => new WaveMemoryWorld({
    cfg: ctx.cfg,
    timezone: ctx.timezone,
    dataDir: ctx.dataDir,
    discoverTools: true,
    secret: (name) => ctx.secret(name),
    botDir: ctx.botDir,
    packageDir: ctx.packageDir,
  }),
};
