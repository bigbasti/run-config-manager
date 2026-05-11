import type { PythonFramework } from '../../shared/types';

export interface FrameworkCommandSpec {
  // Default port (null when not a server framework).
  defaultPort: number | null;
  // Suggested commands shown in the framework-command dropdown when this
  // framework is selected. The first entry is the default.
  commands: string[];
}

export const FRAMEWORK_COMMANDS: Record<PythonFramework, FrameworkCommandSpec> = {
  '': { defaultPort: null, commands: [] },
  django: {
    defaultPort: 8000,
    commands: [
      'runserver',
      'runserver 0.0.0.0:8000',
      'migrate',
      'makemigrations',
      'shell',
      'createsuperuser',
      'test',
      'collectstatic',
    ],
  },
  fastapi: {
    defaultPort: 8000,
    commands: ['app:main --reload'],
  },
  flask: {
    defaultPort: 5000,
    commands: ['--app app run', '--app app run --debug'],
  },
  uvicorn: {
    defaultPort: 8000,
    commands: ['app:main', 'app:main --reload'],
  },
  gunicorn: {
    defaultPort: 8000,
    commands: ['app:app -b 0.0.0.0:8000', 'app:app -w 4 -b 0.0.0.0:8000'],
  },
  celery: {
    defaultPort: null,
    commands: ['-A celery_app worker --loglevel=info', '-A celery_app beat'],
  },
  typer: { defaultPort: null, commands: [] },
  starlette: { defaultPort: 8000, commands: ['app:main'] },
  click: { defaultPort: null, commands: [] },
};
