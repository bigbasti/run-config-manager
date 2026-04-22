import type { RunConfig } from './types';
import type { FormSchema } from './formSchema';

// Messages from webview → extension host
export type Outbound =
  | { cmd: 'ready' }
  | { cmd: 'save'; config: RunConfig }
  | { cmd: 'cancel' }
  | { cmd: 'pickFolder'; current?: string };

// Messages from extension host → webview
export type Inbound =
  | {
      cmd: 'init';
      mode: 'create' | 'edit';
      config: Partial<RunConfig>;
      schema: FormSchema;
    }
  | { cmd: 'folderPicked'; path: string }
  | { cmd: 'error'; message: string };
