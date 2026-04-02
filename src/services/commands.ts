import type {
  CommandRequest,
  CommandResult,
  CommandHandler,
  WsMessage,
} from '../lib/types.js';
import type { WsClient } from './websocket.js';
import type { Logger } from '../lib/logger.js';

export class CommandExecutor {
  private registry = new Map<string, CommandHandler>();
  private wsClient: WsClient;
  private logger: Logger;

  constructor(wsClient: WsClient, logger: Logger) {
    this.wsClient = wsClient;
    this.logger = logger;
  }

  register(command: string, handler: CommandHandler): void {
    this.registry.set(command, handler);
    this.logger.debug(`Command registered: ${command}`);
  }

  getRegisteredCommands(): string[] {
    return Array.from(this.registry.keys());
  }

  /**
   * Handle an incoming command message from the server.
   * Lifecycle: validate → ack → execute → result
   */
  async handleCommand(msg: WsMessage): Promise<void> {
    const request = msg.payload as unknown as CommandRequest;

    if (!request || !request.id || !request.command) {
      this.logger.warn('Invalid command request:', msg);
      return;
    }

    this.logger.info(`Command received: ${request.command} (${request.id})`);

    // Check if command is registered
    const handler = this.registry.get(request.command);
    if (!handler) {
      this.sendResult({
        id: request.id,
        command: request.command,
        success: false,
        error: `Unknown command: ${request.command}`,
        durationMs: 0,
      });
      return;
    }

    // Send ack
    this.wsClient.send({
      type: 'agent:command_ack',
      payload: { id: request.id, command: request.command },
      timestamp: Date.now(),
    });

    // Execute with timeout
    const start = Date.now();
    const timeout = request.timeout || 30_000;
    let timeoutId: NodeJS.Timeout | undefined;

    try {
      const data = await Promise.race([
        handler(request.args),
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => reject(new Error('Command timed out')), timeout);
        }),
      ]);
      clearTimeout(timeoutId);

      this.sendResult({
        id: request.id,
        command: request.command,
        success: true,
        data: (data as Record<string, unknown>) || {},
        durationMs: Date.now() - start,
      });
    } catch (err) {
      clearTimeout(timeoutId);
      this.sendResult({
        id: request.id,
        command: request.command,
        success: false,
        error: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      });
    }
  }

  private sendResult(result: CommandResult): void {
    this.logger.info(
      `Command result: ${result.command} (${result.id}) → ${result.success ? 'OK' : 'FAIL'} in ${result.durationMs}ms`
    );

    this.wsClient.send({
      type: 'agent:command_result',
      payload: result as unknown as Record<string, unknown>,
      timestamp: Date.now(),
    });
  }
}
