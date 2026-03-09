/**
 * Get DOM State Handler for MCP Host RPC Requests
 *
 * This file implements the get_dom_state RPC method handler for the browser extension.
 * It responds to requests from the MCP Host that need the current DOM state in a human-readable format.
 */

import type BrowserContext from '../browser/context';
import { createLogger } from '../log';
import type { RpcHandler, RpcRequest, RpcResponse } from '../mcp/host-manager';
import { DOMElementNode } from '../dom/views';

/**
 * Handler for the 'get_dom_state' RPC method
 *
 * This handler processes DOM state requests from the MCP Host and returns
 * a user-friendly representation of the DOM state.
 */
export class GetDomStateHandler {
  private logger = createLogger('GetDomStateHandler');

  /**
   * Creates a new GetDomStateHandler instance
   *
   * @param browserContext The browser context for accessing DOM state
   */
  constructor(private readonly browserContext: BrowserContext) {}

  /**
   * Handle a get_dom_state RPC request
   *
   * @param request RPC request
   * @returns Promise resolving to an RPC response with the formatted DOM state
   */
  public handleGetDomState: RpcHandler = async (request: RpcRequest): Promise<RpcResponse> => {
    this.logger.debug('Received get_dom_state request:', request);

    try {
      // Get the browser state with vision enabled for better DOM coverage
      const browserState = await this.browserContext.getState(true);

      if (!browserState.elementTree) {
        return {
          error: {
            code: -32000,
            message: 'DOM state not available',
          },
        };
      }

      // Use the same method as Agent to generate human-readable DOM representation
      const interactiveElementsText = browserState.elementTree.clickableElementsToString([
        'role',
        'aria-label',
        'placeholder',
        'name',
        'type',
        'href',
      ]);

      // Add page position markers
      const hasContentAbove = (browserState.pixelsAbove || 0) > 0;
      const hasContentBelow = (browserState.pixelsBelow || 0) > 0;

      let formattedDomText = '';
      if (interactiveElementsText !== '') {
        if (hasContentAbove) {
          formattedDomText = `... ${browserState.pixelsAbove} pixels above - scroll up to see more ...\n${interactiveElementsText}`;
        } else {
          formattedDomText = `[Start of page]\n${interactiveElementsText}`;
        }

        if (hasContentBelow) {
          formattedDomText = `${formattedDomText}\n... ${browserState.pixelsBelow} pixels below - scroll down to see more ...`;
        } else {
          formattedDomText = `${formattedDomText}\n[End of page]\n`;
        }
      } else {
        formattedDomText = 'empty page';
      }

      // Extract interactive elements for easier operation
      const interactiveElements = this.extractInteractiveElements(browserState.elementTree);
      const diagnostics = {
        domNodesCount: browserState.diagnostics?.domNodesCount ?? null,
        interactiveCandidateCount: browserState.diagnostics?.interactiveCandidateCount ?? interactiveElements.length,
        url: browserState.url,
        permissions: browserState.diagnostics?.permissions ?? 'check',
        warning: browserState.diagnostics?.warning,
        originalSize: browserState.diagnostics?.originalSize,
        payloadSize: browserState.diagnostics?.payloadSize,
        payloadTruncated: browserState.diagnostics?.payloadTruncated,
      };

      if (interactiveElements.length === 0) {
        return {
          result: {
            status: 'error/empty',
            diagnostics,
          },
        };
      }

      const isComplexDom =
        (typeof diagnostics.domNodesCount === 'number' && diagnostics.domNodesCount > 1200) ||
        interactiveElements.length > 120 ||
        diagnostics.payloadTruncated === true;

      const markdownSummary = isComplexDom
        ? this.buildComplexDomMarkdownSummary(interactiveElements, browserState.url)
        : undefined;

      const isLargePayload = diagnostics.payloadTruncated === true || diagnostics.warning === 'PAYLOAD_TOO_LARGE';

      // Build structured DOM state response
      const domState = {
        status: isLargePayload ? 'ok/large' : 'ok',
        // Human-readable DOM representation
        formattedDom: isLargePayload && markdownSummary ? markdownSummary : formattedDomText,

        // Structured element information
        interactiveElements,

        // Concise markdown summary for complex pages (n8n-friendly)
        markdownSummary,

        // Extraction and payload diagnostics
        diagnostics,

        // For large payloads, keep technical JSON as optional attachment-like block
        technicalData: isLargePayload
          ? {
              interactiveElements,
              formattedDom: formattedDomText,
              diagnostics,
            }
          : undefined,

        // Page metadata
        meta: {
          url: browserState.url,
          title: browserState.title,
          tabId: browserState.tabId,
          pixelsAbove: browserState.pixelsAbove,
          pixelsBelow: browserState.pixelsBelow,
        },
      };

      this.logger.debug('Returning formatted DOM state for MCP host');

      return {
        result: domState,
      };
    } catch (error) {
      this.logger.error('Error getting DOM state:', error);

      return {
        error: {
          code: -32603,
          message: error instanceof Error ? error.message : 'Unknown error retrieving DOM state',
          data: { stack: error instanceof Error ? error.stack : undefined },
        },
      };
    }
  };

  /**
   * Extract interactive elements from the DOM tree
   *
   * @param tree The DOM element tree
   * @returns Array of interactive elements with metadata
   */
  private extractInteractiveElements(tree: DOMElementNode): any[] {
    const interactiveElements: any[] = [];

    // Use breadth-first search to traverse the DOM tree
    const queue: DOMElementNode[] = [tree];

    while (queue.length > 0) {
      const node = queue.shift();
      if (!node) continue;

      // Add interactive elements with highlight indices
      if (node.isInteractive && Number.isInteger(node.highlightIndex) && (node.highlightIndex as number) >= 0) {
        interactiveElements.push({
          index: node.highlightIndex,
          tagName: node.tagName,
          text: node.getAllTextTillNextClickableElement(),
          attributes: { ...node.attributes },
          isInViewport: node.isInViewport,
          selector: node.getEnhancedCssSelector(),
          isNew: node.isNew,
        });
      }

      // Add children to queue
      for (const child of node.children) {
        if (child instanceof DOMElementNode) {
          queue.push(child);
        }
      }
    }

    return interactiveElements;
  }

  private buildComplexDomMarkdownSummary(interactiveElements: any[], url: string): string {
    const highlightedElements = interactiveElements.filter(
      element => Number.isInteger(element.index) && Number(element.index) >= 0,
    );

    const topElements = [...highlightedElements].sort((a, b) => Number(a.index ?? 0) - Number(b.index ?? 0));

    const rows = topElements.map(element => {
      const index = String(element.index ?? '-');
      const type = String(element.tagName ?? '').toLowerCase() || String(element.attributes?.type ?? '-') || '-';

      const primaryLabel = String(
        element.text ||
          element.attributes?.['aria-label'] ||
          element.attributes?.placeholder ||
          element.attributes?.name ||
          '',
      );
      const rawText = primaryLabel.replace(/\|/g, '\\|').trim();
      const text = rawText.length > 80 ? `${rawText.slice(0, 77)}...` : rawText || '-';

      const idValue = String(element.attributes?.id || '').trim();
      const classValue = String(element.attributes?.class || '').trim();
      const idOrClass = [idValue ? `#${idValue}` : '', classValue ? `.${classValue.replace(/\s+/g, '.')}` : '']
        .filter(Boolean)
        .join(' ')
        .replace(/\|/g, '\\|');

      return `| ${index} | ${type || '-'} | ${text} | ${idOrClass || '-'} |`;
    });

    return [
      '# Radiografia de Elementos Resaltados',
      '',
      `URL: ${url}`,
      `Elementos resaltados: ${highlightedElements.length}`,
      '',
      '| # | Tipo | Texto/Etiqueta | ID/Clase |',
      '| --- | --- | --- | --- |',
      ...rows,
    ].join('\n');
  }
}
