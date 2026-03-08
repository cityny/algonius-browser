import { createLogger } from '../log';
import type { RpcHandler, RpcRequest, RpcResponse } from '../mcp/host-manager';

const logger = createLogger('BrowsingDataHandler');

/**
 * Handler for browsing data RPC commands from MCP Host (n8n)
 * Supports removing browsing data via chrome.browsingData API.
 */
export class BrowsingDataHandler {
  /**
   * Handle browsing_data RPC request
   * params: { action: 'remove', options?: { since?: number }, dataToRemove?: object }
   */
  public handleBrowsingData: RpcHandler = async (request: RpcRequest): Promise<RpcResponse> => {
    logger.debug('Received browsing_data request:', request);

    try {
      const params = request.params || {};
      const action = params.action || 'remove';

      if (action !== 'remove') {
        return {
          error: {
            code: -32602,
            message: `Unsupported action: ${action}`,
          },
        };
      }

      const options = params.options || {};
      const dataToRemove = params.dataToRemove || {
        appcache: true,
        cache: true,
        cacheStorage: true,
        cookies: true,
        fileSystems: true,
        formData: true,
        history: true,
        indexedDB: true,
        localStorage: true,
        passwords: true,
        serviceWorkers: true,
      };

      // Wrap chrome.browsingData.remove in a Promise
      await new Promise<void>((resolve, reject) => {
        try {
          // @ts-ignore - chrome types available in runtime
          chrome.browsingData.remove(options, dataToRemove, () => {
            const err = chrome.runtime.lastError;
            if (err) {
              logger.error('browsingData.remove failed:', err.message);
              reject(err);
            } else {
              logger.info('browsingData.remove completed');
              resolve();
            }
          });
        } catch (e) {
          reject(e);
        }
      });

      return {
        result: {
          success: true,
          action: 'remove',
        },
      };
    } catch (error) {
      logger.error('Error handling browsing_data RPC:', error);
      return {
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : String(error),
          data: { stack: error instanceof Error ? error.stack : undefined },
        },
      };
    }
  };
}
