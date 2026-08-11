import { appendFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { NotificationSink } from "../domain/ports";

export class JsonlNotificationSink implements NotificationSink {
  constructor(private readonly path: string) {}
  async send(message: string): Promise<void> {
    await mkdir(dirname(this.path), { recursive: true });
    await appendFile(this.path, `${message}\n`);
  }
}
