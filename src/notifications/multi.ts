import type { NotificationSink } from "../domain/ports";

export class MultiNotificationSink implements NotificationSink {
  constructor(private readonly sinks: NotificationSink[]) {}
  async send(message: string): Promise<void> {
    const results = await Promise.allSettled(this.sinks.map((sink) => sink.send(message)));
    const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failure) throw failure.reason;
  }
}
