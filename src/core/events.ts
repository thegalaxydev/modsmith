export type EventListener = (event: string, data: unknown) => void;

export class EventBus {
  private listeners = new Set<EventListener>();

  on(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: string, data: unknown): void {
    for (const l of this.listeners) {
      try {
        l(event, data);
      } catch (err) {
        console.error('event listener failed', err);
      }
    }
  }
}
