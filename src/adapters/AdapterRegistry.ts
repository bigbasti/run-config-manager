import type { RuntimeAdapter } from './RuntimeAdapter';
import type { RunConfigType } from '../shared/types';

export class AdapterRegistry {
  private byType = new Map<RunConfigType, RuntimeAdapter>();

  register(adapter: RuntimeAdapter): void {
    this.byType.set(adapter.type, adapter);
  }

  get(type: RunConfigType): RuntimeAdapter | undefined {
    return this.byType.get(type);
  }

  all(): RuntimeAdapter[] {
    return Array.from(this.byType.values());
  }
}
