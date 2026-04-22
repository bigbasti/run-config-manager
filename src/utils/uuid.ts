import { v4 } from 'uuid';

export function newId(): string {
  return v4();
}
