import type { RunConfig } from './types';
import type { FormSchema } from './formSchema';

export type Outbound =
  | { cmd: 'ready' }
  | { cmd: 'save'; config: RunConfig }
  | { cmd: 'cancel' }
  | { cmd: 'pickFolder'; current?: string }
  | { cmd: 'recomputeClasspath'; config: RunConfig };

export type Inbound =
  | {
      cmd: 'init';
      mode: 'create' | 'edit';
      config: Partial<RunConfig>;
      schema: FormSchema;
    }
  | { cmd: 'folderPicked'; path: string }
  | { cmd: 'classpathComputed'; classpath: string }
  | { cmd: 'error'; message: string };
