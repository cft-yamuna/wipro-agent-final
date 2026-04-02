import { z } from 'zod';
import type { AgentConfig, Identity } from '../lib/types.js';
import { readIdentity, writeIdentity } from '../lib/identity.js';
import type { Logger } from '../lib/logger.js';

const provisionResponseSchema = z.object({
  deviceId: z.string().uuid(),
  apiKey: z.string().min(1),
});

interface ProvisionResult {
  identity: Identity;
  fromCache: boolean;
}

/**
 * Provision the agent: check for cached identity, otherwise call CMS provisioning endpoints.
 * If pairing is required, polls until admin approves (with timeout).
 */
export async function provision(
  config: AgentConfig,
  logger: Logger
): Promise<ProvisionResult> {
  // Check for cached identity first
  const cached = readIdentity(config.identityFile);
  if (cached) {
    logger.info('Using cached identity', { deviceId: cached.deviceId });
    return { identity: cached, fromCache: true };
  }

  logger.info(`Provisioning device: ${config.deviceSlug}`);

  const baseUrl = `${config.serverUrl}/api/devices/provision/${encodeURIComponent(config.deviceSlug)}`;

  // Step 1: Request provisioning
  const res = await fetch(baseUrl);
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Provision request failed (${res.status}): ${body}`);
  }

  const data = await res.json() as Record<string, unknown>;

  // Auto-provisioned (IP match)
  if (data.deviceId && data.apiKey) {
    const parsed = provisionResponseSchema.safeParse(data);
    if (!parsed.success) {
      throw new Error('Invalid provision response: ' + parsed.error.message);
    }
    const identity: Identity = {
      deviceId: parsed.data.deviceId,
      apiKey: parsed.data.apiKey,
    };
    writeIdentity(config.identityFile, identity);
    logger.info('Auto-provisioned', { deviceId: identity.deviceId });
    return { identity, fromCache: false };
  }

  // Pairing required — display code and poll
  if (data.requiresPairing && data.code) {
    const code = data.code as string;
    logger.warn(`Pairing required. Enter code in admin UI: ${code}`);
    logger.info('Waiting for admin to approve pairing...');

    const identity = await pollForPairing(
      `${baseUrl}/status?code=${encodeURIComponent(code)}`,
      logger
    );

    writeIdentity(config.identityFile, identity);
    logger.info('Pairing complete', { deviceId: identity.deviceId });
    return { identity, fromCache: false };
  }

  throw new Error('Unexpected provision response: ' + JSON.stringify(data));
}

async function pollForPairing(
  statusUrl: string,
  logger: Logger,
  timeoutMs = 600_000,
  intervalMs = 5_000
): Promise<Identity> {
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    try {
      const res = await fetch(statusUrl);
      if (!res.ok) {
        logger.warn(`Pairing poll failed (${res.status}), retrying...`);
        continue;
      }

      const data = await res.json() as Record<string, unknown>;

      if (data.deviceId && data.apiKey) {
        const parsed = provisionResponseSchema.safeParse(data);
        if (!parsed.success) {
          throw new Error('Invalid pairing response: ' + parsed.error.message);
        }
        return {
          deviceId: parsed.data.deviceId,
          apiKey: parsed.data.apiKey,
        };
      }

      logger.debug('Pairing not yet complete, polling again...');
    } catch (err) {
      logger.warn('Pairing poll error, retrying...', err);
    }
  }

  throw new Error('Pairing timed out after ' + (timeoutMs / 1000) + 's');
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
