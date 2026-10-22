import { store, type AskOptions } from './store';

export function ask(text: string, opts?: AskOptions): Promise<boolean> {
  return store.ask(text, opts);
}

export function tell(text: string): Promise<void> {
  return store.tell(text);
}
