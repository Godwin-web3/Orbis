import type { NotificationSink } from "../domain/ports";
export class ConsoleNotificationSink implements NotificationSink { async send(message: string) { console.log(`${new Date().toISOString()} ${message}`); } }
