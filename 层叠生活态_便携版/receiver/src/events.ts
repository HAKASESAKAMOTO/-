import fs from 'node:fs/promises';
import path from 'node:path';
import type { ReceiverEvent } from './types.js';

type Listener = (event: ReceiverEvent) => void;

export class EventBus {
  private readonly listeners = new Set<Listener>();

  constructor(private readonly eventsDir: string) {}

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async emit<T>(event: ReceiverEvent<T>): Promise<void> {
    await fs.mkdir(this.eventsDir, { recursive: true });
    const line = `${JSON.stringify(event)}\n`;
    await fs.appendFile(path.join(this.eventsDir, 'receiver.log.jsonl'), line, 'utf8');
    for (const listener of this.listeners) listener(event as ReceiverEvent);
  }

  emitEphemeral<T>(event: ReceiverEvent<T>): void {
    for (const listener of this.listeners) listener(event as ReceiverEvent);
  }
}
